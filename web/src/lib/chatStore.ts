/**
 * chatStore — framework-agnostic backend state management for the dashboard
 * chat interface.
 *
 * ## Why this exists
 *
 * The dashboard already has a chat backend: the `tui_gateway` JSON-RPC server
 * owns agent sessions, persists every message to the SQLite session store
 * (`hermes_state.py`), and exposes `session.create` / `session.list` /
 * `session.delete` plus the REST `/api/sessions*` endpoints. What it did *not*
 * have was a client-side layer that makes the chat **stateful across page
 * refreshes and navigations**:
 *
 *   - `ChatPage` created a fresh gateway session on every mount and only
 *     survived a refresh via the `?resume=<id>` URL param — which is lost the
 *     moment you navigate to any non-chat route.
 *   - There was no shared notion of "the set of chats" or "the active chat"
 *     that a pinned, minimizable widget (rendered above the router) could read.
 *
 * `ChatStore` fills that gap. It is the single source of truth on the client
 * for:
 *
 *   - the **session registry** (create / list / delete chat sessions),
 *   - the **active session** selection,
 *   - **per-session messages** (fetched from the server, cached in memory),
 *   - durable **UI/navigation state** (active id + widget open/minimized),
 *     persisted to `localStorage` so it survives refreshes and is identical
 *     across every route.
 *
 * The *content* of chats (messages) stays server-owned — we never duplicate
 * the transcript into localStorage, we only persist the lightweight pointers
 * needed to reconstruct "where the user was". This keeps the client honest:
 * the server remains the source of truth, and a cleared localStorage just
 * resets the view, never loses a conversation.
 *
 * ## Design notes
 *
 * - **Framework-agnostic on purpose.** No React imports live here. The store
 *   is a plain observable object with `subscribe()` / `getSnapshot()` so it can
 *   be driven by `useSyncExternalStore` (see `ChatStoreProvider`), unit-tested
 *   without a renderer, or reused by a plugin. This is the "minimal shared
 *   module for the frontend to use" the task asks for.
 *
 * - **Transport injection.** All server access goes through a `ChatStoreDeps`
 *   bag. Production wires it to the real gateway client + REST `api`; tests
 *   inject fakes. The store never reaches for globals.
 *
 * - **Stable, shallow-frozen snapshots.** `getSnapshot()` returns a
 *   shallow-`Object.freeze`d, referentially stable object that only changes
 *   identity when state actually changes, so React's `useSyncExternalStore`
 *   re-renders precisely. The freeze is shallow (top-level only): nested
 *   `sessions` / `messages` arrays and their elements are reused by reference
 *   across snapshots and must be treated as read-only by consumers — never
 *   mutate them in place. We deliberately do not deep-freeze on every update
 *   to keep this hot path cheap; all internal mutations go through copy-on-
 *   write in `setState`.
 */

/** A chat session as the store tracks it. Mirrors the server's `SessionInfo`
 *  but trimmed to what the chat UI needs. */
export interface ChatSession {
  /** Server session id (gateway + REST share this id space). */
  id: string;
  /** Human title; null until the server/agent assigns one. */
  title: string | null;
  /** Profile this chat converses with, if the caller pinned one. The config
   *  task (profile selection per chat) sets this; null means "default". */
  profile: string | null;
  /** Model identifier reported by the gateway, if known. */
  model: string | null;
  /** Epoch seconds the session was created. */
  createdAt: number;
  /** Epoch seconds of last activity (used for list ordering). */
  lastActive: number;
  /** Short preview of the latest message, for list rows. */
  preview: string | null;
  /** Cached message count from the server listing. */
  messageCount: number;
}

/** A single chat message. Matches the server's `SessionMessage` shape. */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  timestamp?: number;
  toolName?: string;
}

/** Immutable view of the whole store. */
export interface ChatStoreState {
  /** All known sessions, newest activity first. */
  sessions: ChatSession[];
  /** Currently selected session id, or null if none. */
  activeSessionId: string | null;
  /** Messages for the active session (empty until loaded). */
  messages: ChatMessage[];
  /** True while a server round-trip is in flight. */
  loading: boolean;
  /** Last error surfaced to the UI, or null. */
  error: string | null;
  /** Whether the pinned chat widget is open at all. */
  widgetOpen: boolean;
  /** Whether the open widget is minimized to its title bar. */
  minimized: boolean;
  /** Whether the initial server hydration has completed. */
  hydrated: boolean;
}

/** Server-access surface the store depends on. Injected so the store has no
 *  hard dependency on the gateway client or `fetch`, which makes it trivially
 *  testable and reusable. */
export interface ChatStoreDeps {
  /** Create a new server session, optionally pinned to a profile. Returns the
   *  new session id (and whatever metadata the gateway hands back). */
  createSession(opts?: {
    profile?: string | null;
  }): Promise<{ id: string; title?: string | null; model?: string | null }>;
  /** List existing sessions (most-recent first is fine; the store re-sorts). */
  listSessions(): Promise<ChatSession[]>;
  /** Delete a session server-side. */
  deleteSession(id: string): Promise<void>;
  /** Fetch the full message transcript for a session. */
  loadMessages(id: string): Promise<ChatMessage[]>;
}

/** Persistence surface for the durable UI/navigation pointers. Defaults to
 *  `window.localStorage` but is injectable for tests / SSR safety. */
export interface ChatStorePersistence {
  read(): PersistedChatState | null;
  write(state: PersistedChatState): void;
  clear(): void;
}

/** The lightweight, durable slice we persist across refreshes. Deliberately
 *  excludes message content — the server owns that. */
export interface PersistedChatState {
  activeSessionId: string | null;
  widgetOpen: boolean;
  minimized: boolean;
}

const STORAGE_KEY = "hermes.chat.v1";

const INITIAL_STATE: ChatStoreState = Object.freeze({
  sessions: [],
  activeSessionId: null,
  messages: [],
  loading: false,
  error: null,
  widgetOpen: false,
  minimized: false,
  hydrated: false,
});

/** Build a `ChatStorePersistence` backed by the given `Storage` (or null when
 *  unavailable, e.g. SSR or privacy mode). */
export function localStoragePersistence(
  storage: Storage | null = safeLocalStorage(),
): ChatStorePersistence {
  return {
    read() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
        const widgetOpen = parsed.widgetOpen === true;
        return {
          activeSessionId:
            typeof parsed.activeSessionId === "string"
              ? parsed.activeSessionId
              : null,
          widgetOpen,
          // Normalize the invariant on read too: a closed widget can never be
          // "minimized". This repairs corrupt or older persisted values that
          // predate `closeWidget()` enforcing it.
          minimized: widgetOpen && parsed.minimized === true,
        };
      } catch {
        return null;
      }
    },
    write(state) {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* quota / disabled storage — degrade silently */
      }
    },
    clear() {
      if (!storage) return;
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

/** localStorage access that never throws (Safari private mode, SSR, etc.). */
function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    // Touch it to surface privacy-mode throwers eagerly.
    const probe = "__hermes_chat_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Sort newest-activity-first; stable on ties by id for deterministic output. */
function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => {
    if (b.lastActive !== a.lastActive) return b.lastActive - a.lastActive;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The chat state manager. One instance is created per app (see
 * `ChatStoreProvider`) and shared across every route.
 */
export class ChatStore {
  private state: ChatStoreState = INITIAL_STATE;
  private listeners = new Set<() => void>();
  /** Monotonic token for message loads; only the latest load may mutate
   *  `messages`/`loading`, so a slow request for a since-abandoned session
   *  can't clobber a newer one's result or loading flag. */
  private loadToken = 0;
  private readonly deps: ChatStoreDeps;
  private readonly persistence: ChatStorePersistence;

  constructor(deps: ChatStoreDeps, persistence?: ChatStorePersistence) {
    this.deps = deps;
    this.persistence = persistence ?? localStoragePersistence();
  }

  // ---- observable plumbing (useSyncExternalStore contract) ----------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ChatStoreState => this.state;

  private setState(patch: Partial<ChatStoreState>): void {
    const next = { ...this.state, ...patch };
    // Skip no-op updates so referential equality holds and React doesn't
    // re-render needlessly.
    let changed = false;
    for (const key of Object.keys(next) as (keyof ChatStoreState)[]) {
      if (next[key] !== this.state[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = Object.freeze(next);
    for (const l of this.listeners) l();
  }

  private persist(): void {
    this.persistence.write({
      activeSessionId: this.state.activeSessionId,
      widgetOpen: this.state.widgetOpen,
      minimized: this.state.minimized,
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Restore durable UI pointers from localStorage, then reconcile against the
   * live server session list. Safe to call multiple times; the first call
   * flips `hydrated` true.
   *
   * Reconciliation rules:
   *   - The persisted `activeSessionId` is kept only if it still resolves to a
   *     live server session (handles server-side deletes / purges).
   *   - If no valid active session remains but sessions exist, none is forced
   *     active — the UI decides whether to auto-open the newest.
   */
  async hydrate(): Promise<void> {
    const persisted = this.persistence.read();
    if (persisted) {
      this.setState({
        activeSessionId: persisted.activeSessionId,
        widgetOpen: persisted.widgetOpen,
        minimized: persisted.minimized,
      });
    }

    const refreshed = await this.refreshSessions();

    // Only reconcile the persisted active id against the server list if we
    // actually fetched it. If the refresh failed, the empty `sessions` is not
    // authoritative — pruning here would wrongly drop (and persist the loss of)
    // a valid active session just because the network was down.
    if (refreshed) {
      const ids = new Set(this.state.sessions.map((s) => s.id));
      if (this.state.activeSessionId && !ids.has(this.state.activeSessionId)) {
        // Dangling active id that no longer exists server-side — prune it.
        this.setState({ activeSessionId: null, messages: [] });
        this.persist();
      } else if (this.state.activeSessionId) {
        // Re-load the active session's messages after a refresh.
        await this.loadActiveMessages();
      }
    }

    this.setState({ hydrated: true });
  }

  // ---- session registry ---------------------------------------------------

  /** Pull the current session list from the server and merge it into state.
   *  Returns true on success, false if the fetch failed (so callers like
   *  `hydrate()` can avoid acting on an empty list they didn't actually get). */
  async refreshSessions(): Promise<boolean> {
    this.setState({ loading: true, error: null });
    try {
      const fetched = await this.deps.listSessions();
      // Merge rather than replace wholesale: preserve locally-known metadata
      // that the server listing doesn't (yet) round-trip — notably `profile`,
      // which is set at creation but absent from the server `SessionInfo`. For
      // sessions we already know about, keep a non-null local `profile` when
      // the fetched copy has none.
      const prevById = new Map(this.state.sessions.map((s) => [s.id, s]));
      const merged = fetched.map((s) => {
        const prev = prevById.get(s.id);
        if (prev && s.profile == null && prev.profile != null) {
          return { ...s, profile: prev.profile };
        }
        return s;
      });
      this.setState({ sessions: sortSessions(merged), loading: false });
      return true;
    } catch (e) {
      this.setState({ loading: false, error: errMsg(e) });
      return false;
    }
  }

  /**
   * Create a new chat session (optionally pinned to a profile), insert it into
   * the registry, select it, and clear the message pane. Returns the new id.
   */
  async createSession(opts?: {
    profile?: string | null;
  }): Promise<string | null> {
    this.setState({ loading: true, error: null });
    try {
      const created = await this.deps.createSession(opts);
      const now = Math.floor(Date.now() / 1000);
      const session: ChatSession = {
        id: created.id,
        title: created.title ?? null,
        profile: opts?.profile ?? null,
        model: created.model ?? null,
        createdAt: now,
        lastActive: now,
        preview: null,
        messageCount: 0,
      };
      this.setState({
        sessions: sortSessions([
          session,
          ...this.state.sessions.filter((s) => s.id !== session.id),
        ]),
        activeSessionId: session.id,
        messages: [],
        loading: false,
      });
      this.persist();
      return session.id;
    } catch (e) {
      this.setState({ loading: false, error: errMsg(e) });
      return null;
    }
  }

  /**
   * Delete a session server-side and drop it from the registry. If it was the
   * active session, selection clears.
   */
  async deleteSession(id: string): Promise<void> {
    this.setState({ loading: true, error: null });
    try {
      await this.deps.deleteSession(id);
      const sessions = this.state.sessions.filter((s) => s.id !== id);
      const wasActive = this.state.activeSessionId === id;
      if (wasActive) {
        // Invalidate any in-flight loadActiveMessages so it can't commit a
        // transcript for the session we just cleared.
        this.loadToken++;
      }
      this.setState({
        sessions,
        loading: false,
        activeSessionId: wasActive ? null : this.state.activeSessionId,
        messages: wasActive ? [] : this.state.messages,
      });
      this.persist();
    } catch (e) {
      this.setState({ loading: false, error: errMsg(e) });
    }
  }

  // ---- active session + messages ------------------------------------------

  /** Select a session as active and load its messages. Pass null to clear. */
  async selectSession(id: string | null): Promise<void> {
    if (id === this.state.activeSessionId) return;
    // Invalidate any in-flight load before switching, so a slow load for the
    // previous session (or for null) can't commit after this change. When
    // `id` is non-null, loadActiveMessages() below bumps the token again to
    // its own value; clearing to null relies solely on this bump. Reset
    // `loading` here too, since the invalidated load returns early without
    // clearing it (otherwise a clear-to-null could leave `loading` stuck on).
    this.loadToken++;
    this.setState({ activeSessionId: id, messages: [], loading: false });
    this.persist();
    if (id) await this.loadActiveMessages();
  }

  /** (Re)load messages for the active session from the server. */
  async loadActiveMessages(): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) {
      this.setState({ messages: [] });
      return;
    }
    const token = ++this.loadToken;
    this.setState({ loading: true, error: null });
    try {
      const messages = await this.deps.loadMessages(id);
      // Only the most recent load may mutate state. A superseded request
      // (the user switched sessions, or fired another reload) must not flip
      // `loading` off or overwrite the newer transcript.
      if (token !== this.loadToken) return;
      this.setState({ messages, loading: false });
    } catch (e) {
      if (token !== this.loadToken) return;
      this.setState({ loading: false, error: errMsg(e) });
    }
  }

  /**
   * Append a single complete message to the active session's in-memory
   * transcript. Intended for optimistic UI — e.g. echoing the user's
   * just-sent line, or appending a finished assistant message — before the
   * authoritative server copy lands. No-op if there is no active session.
   *
   * This is append-only: each call adds one message and bumps `messageCount`.
   * It is NOT a streaming-delta accumulator — callers rendering token-by-token
   * deltas should buffer them and append once the message completes (or manage
   * the in-progress message in their own component state), otherwise the
   * transcript and `messageCount` would inflate with partial fragments.
   */
  appendMessage(message: ChatMessage): void {
    if (!this.state.activeSessionId) return;
    const id = this.state.activeSessionId;
    const updated = this.state.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            lastActive: message.timestamp ?? Math.floor(Date.now() / 1000),
            messageCount: s.messageCount + 1,
            preview:
              typeof message.content === "string"
                ? message.content.slice(0, 140)
                : s.preview,
          }
        : s,
    );
    this.setState({
      messages: [...this.state.messages, message],
      // Re-sort so the "newest activity first" invariant documented on
      // `ChatStoreState.sessions` holds after activity in a non-first session.
      sessions: sortSessions(updated),
    });
  }

  // ---- widget UI state (durable across refresh + navigation) --------------

  /** Open the pinned chat widget. */
  openWidget(): void {
    this.setState({ widgetOpen: true, minimized: false });
    this.persist();
  }

  /** Fully close (dismiss) the widget. Does not delete any chat. Resets
   *  `minimized` so we never persist the inconsistent
   *  `widgetOpen:false + minimized:true` combination. */
  closeWidget(): void {
    this.setState({ widgetOpen: false, minimized: false });
    this.persist();
  }

  /** Toggle the open widget between minimized and expanded. No-op when the
   *  widget is closed (a closed widget can't be minimized). */
  toggleMinimized(): void {
    if (!this.state.widgetOpen) return;
    this.setState({ minimized: !this.state.minimized });
    this.persist();
  }

  /** Explicitly set the minimized flag. Coerced to false while the widget is
   *  closed so the `widgetOpen:false + minimized:true` invariant can't be
   *  violated. */
  setMinimized(minimized: boolean): void {
    this.setState({ minimized: minimized && this.state.widgetOpen });
    this.persist();
  }

  // ---- helpers for consumers / tests --------------------------------------

  /** Current active session object, or null. */
  getActiveSession(): ChatSession | null {
    return (
      this.state.sessions.find((s) => s.id === this.state.activeSessionId) ??
      null
    );
  }

  /** Wipe persisted UI state (does not touch server sessions). */
  resetPersisted(): void {
    this.persistence.clear();
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}
