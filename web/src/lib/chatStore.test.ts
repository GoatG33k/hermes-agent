import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatStore,
  localStoragePersistence,
  type ChatMessage,
  type ChatSession,
  type ChatStoreDeps,
  type ChatStorePersistence,
  type PersistedChatState,
} from "@/lib/chatStore";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** An in-memory backend that behaves like the gateway/REST pair, so the store
 *  can be exercised without a network. */
function makeFakeBackend(initial: ChatSession[] = []) {
  const sessions = new Map<string, ChatSession>();
  for (const s of initial) sessions.set(s.id, s);
  const messages = new Map<string, ChatMessage[]>();
  let counter = 0;

  const deps: ChatStoreDeps = {
    async createSession(opts) {
      counter += 1;
      const id = `s${counter}`;
      const now = Math.floor(Date.now() / 1000);
      sessions.set(id, {
        id,
        title: null,
        profile: opts?.profile ?? null,
        model: "anthropic/claude-test",
        createdAt: now,
        lastActive: now,
        preview: null,
        messageCount: 0,
      });
      messages.set(id, []);
      return { id, model: "anthropic/claude-test", title: null };
    },
    async listSessions() {
      return [...sessions.values()].map((s) => ({ ...s }));
    },
    async deleteSession(id) {
      if (!sessions.has(id)) throw new Error("session not found");
      sessions.delete(id);
      messages.delete(id);
    },
    async loadMessages(id) {
      return [...(messages.get(id) ?? [])];
    },
  };

  return {
    deps,
    sessions,
    seedMessages(id: string, msgs: ChatMessage[]) {
      messages.set(id, msgs);
    },
  };
}

/** In-memory persistence so each test is isolated and we can simulate a
 *  "page refresh" by constructing a fresh store over the same backing slot. */
function makeMemoryPersistence(): ChatStorePersistence & {
  snapshot: () => PersistedChatState | null;
} {
  let slot: PersistedChatState | null = null;
  return {
    read: () => (slot ? { ...slot } : null),
    write: (s) => {
      slot = { ...s };
    },
    clear: () => {
      slot = null;
    },
    snapshot: () => (slot ? { ...slot } : null),
  };
}

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: null,
    profile: null,
    model: null,
    createdAt: 1000,
    lastActive: 1000,
    preview: null,
    messageCount: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Session registry: create / list / delete
// ---------------------------------------------------------------------------

describe("ChatStore — session registry", () => {
  let backend: ReturnType<typeof makeFakeBackend>;
  let persistence: ReturnType<typeof makeMemoryPersistence>;
  let store: ChatStore;

  beforeEach(() => {
    backend = makeFakeBackend();
    persistence = makeMemoryPersistence();
    store = new ChatStore(backend.deps, persistence);
  });

  it("lists sessions from the backend, newest activity first", async () => {
    backend.sessions.set("a", session("a", { lastActive: 100 }));
    backend.sessions.set("b", session("b", { lastActive: 300 }));
    backend.sessions.set("c", session("c", { lastActive: 200 }));

    await store.refreshSessions();

    expect(store.getSnapshot().sessions.map((s) => s.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("creates a session, selects it, and adds it to the registry", async () => {
    const id = await store.createSession();
    expect(id).toBe("s1");

    const state = store.getSnapshot();
    expect(state.activeSessionId).toBe("s1");
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.id).toBe("s1");
    expect(state.messages).toEqual([]);
  });

  it("forwards the requested profile into the new session", async () => {
    await store.createSession({ profile: "minerva" });
    expect(store.getActiveSession()?.profile).toBe("minerva");
  });

  it("deletes a session and removes it from the registry", async () => {
    const id = await store.createSession();
    expect(store.getSnapshot().sessions).toHaveLength(1);

    await store.deleteSession(id!);

    const state = store.getSnapshot();
    expect(state.sessions).toHaveLength(0);
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("deleting a non-active session keeps the active selection intact", async () => {
    await store.createSession(); // s1
    const second = await store.createSession(); // s2 (active)
    await store.selectSession(second);

    await store.deleteSession("s1");

    const state = store.getSnapshot();
    expect(state.activeSessionId).toBe("s2");
    expect(state.sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("surfaces a backend error instead of throwing", async () => {
    const failing: ChatStoreDeps = {
      ...backend.deps,
      listSessions: () => Promise.reject(new Error("boom")),
    };
    const s = new ChatStore(failing, persistence);
    await s.refreshSessions();
    expect(s.getSnapshot().error).toBe("boom");
    expect(s.getSnapshot().loading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Messages: stored and retrievable per session
// ---------------------------------------------------------------------------

describe("ChatStore — messages per session", () => {
  it("loads the active session's messages from the backend", async () => {
    const backend = makeFakeBackend();
    const store = new ChatStore(backend.deps, makeMemoryPersistence());

    const id = await store.createSession();
    backend.seedMessages(id!, [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
    ]);

    await store.loadActiveMessages();

    expect(store.getSnapshot().messages).toEqual([
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
    ]);
  });

  it("keeps messages isolated per session when switching", async () => {
    const backend = makeFakeBackend();
    const store = new ChatStore(backend.deps, makeMemoryPersistence());

    const a = await store.createSession();
    backend.seedMessages(a!, [{ role: "user", content: "in A" }]);
    const b = await store.createSession();
    backend.seedMessages(b!, [{ role: "user", content: "in B" }]);

    await store.selectSession(a);
    expect(store.getSnapshot().messages).toEqual([
      { role: "user", content: "in A" },
    ]);

    await store.selectSession(b);
    expect(store.getSnapshot().messages).toEqual([
      { role: "user", content: "in B" },
    ]);
  });

  it("appendMessage optimistically updates transcript + session preview", async () => {
    const backend = makeFakeBackend();
    const store = new ChatStore(backend.deps, makeMemoryPersistence());
    await store.createSession();

    store.appendMessage({ role: "user", content: "optimistic line" });

    const state = store.getSnapshot();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("optimistic line");
    expect(state.sessions[0]?.preview).toBe("optimistic line");
    expect(state.sessions[0]?.messageCount).toBe(1);
  });

  it("appendMessage re-sorts so the active session moves to the front", async () => {
    const backend = makeFakeBackend();
    const store = new ChatStore(backend.deps, makeMemoryPersistence());
    // Two sessions; s1 created first, s2 second (s2 ends up active + first).
    await store.createSession(); // s1
    await store.createSession(); // s2 (active)
    // Re-select the older s1 so it becomes active but is NOT first in order.
    await store.selectSession("s1");

    store.appendMessage({
      role: "user",
      content: "bump s1",
      timestamp: Math.floor(Date.now() / 1000) + 1000,
    });

    // s1 must now be first by the "newest activity first" invariant.
    expect(store.getSnapshot().sessions[0]?.id).toBe("s1");
  });

  it("clears messages when no session is active", async () => {
    const backend = makeFakeBackend();
    const store = new ChatStore(backend.deps, makeMemoryPersistence());
    await store.loadActiveMessages();
    expect(store.getSnapshot().messages).toEqual([]);
  });

  it("a superseded loadMessages cannot clobber a newer load's result", async () => {
    // Two sessions whose loadMessages resolve out of order. The slow first
    // request must NOT overwrite the fast second request's transcript.
    const resolvers: Record<string, (msgs: ChatMessage[]) => void> = {};
    const deps: ChatStoreDeps = {
      async createSession() {
        const id = Object.keys(resolvers).length === 0 ? "slow" : "fast";
        return { id };
      },
      async listSessions() {
        return [session("slow"), session("fast")];
      },
      async deleteSession() {},
      loadMessages(id) {
        return new Promise<ChatMessage[]>((resolve) => {
          resolvers[id] = resolve;
        });
      },
    };
    const store = new ChatStore(deps, makeMemoryPersistence());
    await store.refreshSessions();

    // Kick off load for "slow", then immediately switch to "fast".
    const slowLoad = store.selectSession("slow");
    const fastLoad = store.selectSession("fast");

    // Resolve fast first, then slow (the stale one).
    resolvers["fast"]?.([{ role: "assistant", content: "FAST" }]);
    resolvers["slow"]?.([{ role: "assistant", content: "SLOW" }]);
    await Promise.all([slowLoad, fastLoad]);

    const state = store.getSnapshot();
    expect(state.activeSessionId).toBe("fast");
    expect(state.messages).toEqual([{ role: "assistant", content: "FAST" }]);
    expect(state.loading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persistence across refreshes + navigations
// ---------------------------------------------------------------------------

describe("ChatStore — persistence across refresh", () => {
  it("restores the active session and widget state after a simulated refresh", async () => {
    const backend = makeFakeBackend();
    const persistence = makeMemoryPersistence();

    // --- session 1: user opens chat, creates a session, minimizes widget ---
    const store1 = new ChatStore(backend.deps, persistence);
    const id = await store1.createSession();
    store1.openWidget();
    store1.setMinimized(true);
    backend.seedMessages(id!, [{ role: "user", content: "persisted msg" }]);

    expect(persistence.snapshot()).toEqual({
      activeSessionId: id,
      widgetOpen: true,
      minimized: true,
    });

    // --- "page refresh": brand-new store over the same persistence + backend
    const store2 = new ChatStore(backend.deps, persistence);
    await store2.hydrate();

    const state = store2.getSnapshot();
    expect(state.hydrated).toBe(true);
    expect(state.activeSessionId).toBe(id);
    expect(state.widgetOpen).toBe(true);
    expect(state.minimized).toBe(true);
    // Messages are re-fetched from the (server) backend, not from localStorage.
    expect(state.messages).toEqual([
      { role: "user", content: "persisted msg" },
    ]);
  });

  it("prunes a persisted active session that no longer exists server-side", async () => {
    const backend = makeFakeBackend();
    const persistence = makeMemoryPersistence();

    const store1 = new ChatStore(backend.deps, persistence);
    const id = await store1.createSession();
    store1.openWidget();

    // Simulate a server-side purge: the session vanishes from the backend.
    backend.sessions.delete(id!);

    const store2 = new ChatStore(backend.deps, persistence);
    await store2.hydrate();

    const state = store2.getSnapshot();
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
    // The widget flag survives — only the dangling session pointer is cleared.
    expect(state.widgetOpen).toBe(true);
  });

  it("does not duplicate message content into the persisted slot", async () => {
    const backend = makeFakeBackend();
    const persistence = makeMemoryPersistence();
    const store = new ChatStore(backend.deps, persistence);

    await store.createSession();
    store.appendMessage({ role: "user", content: "secret content" });

    const persisted = persistence.snapshot();
    expect(JSON.stringify(persisted)).not.toContain("secret content");
    expect(Object.keys(persisted!)).toEqual([
      "activeSessionId",
      "widgetOpen",
      "minimized",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Widget UI state
// ---------------------------------------------------------------------------

describe("ChatStore — widget state", () => {
  let store: ChatStore;
  let persistence: ReturnType<typeof makeMemoryPersistence>;

  beforeEach(() => {
    persistence = makeMemoryPersistence();
    store = new ChatStore(makeFakeBackend().deps, persistence);
  });

  it("open / close toggles widgetOpen and persists", () => {
    store.openWidget();
    expect(store.getSnapshot().widgetOpen).toBe(true);
    expect(persistence.snapshot()?.widgetOpen).toBe(true);

    store.closeWidget();
    expect(store.getSnapshot().widgetOpen).toBe(false);
    expect(persistence.snapshot()?.widgetOpen).toBe(false);
  });

  it("closing resets minimized so the inconsistent combo is never persisted", () => {
    store.openWidget();
    store.setMinimized(true);
    store.closeWidget();
    expect(store.getSnapshot().minimized).toBe(false);
    expect(persistence.snapshot()).toEqual({
      activeSessionId: null,
      widgetOpen: false,
      minimized: false,
    });
  });

  it("toggleMinimized flips and persists the flag", () => {
    expect(store.getSnapshot().minimized).toBe(false);
    store.toggleMinimized();
    expect(store.getSnapshot().minimized).toBe(true);
    expect(persistence.snapshot()?.minimized).toBe(true);
    store.toggleMinimized();
    expect(store.getSnapshot().minimized).toBe(false);
  });

  it("opening clears the minimized flag", () => {
    store.setMinimized(true);
    store.openWidget();
    expect(store.getSnapshot().minimized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Observable contract (useSyncExternalStore)
// ---------------------------------------------------------------------------

describe("ChatStore — observable contract", () => {
  it("notifies subscribers only on real state changes", async () => {
    const store = new ChatStore(makeFakeBackend().deps, makeMemoryPersistence());
    const spy = vi.fn();
    const unsub = store.subscribe(spy);

    await store.createSession();
    const callsAfterCreate = spy.mock.calls.length;
    expect(callsAfterCreate).toBeGreaterThan(0);

    // Selecting the already-active session is a no-op → no new notification.
    const activeId = store.getSnapshot().activeSessionId!;
    await store.selectSession(activeId);
    expect(spy.mock.calls.length).toBe(callsAfterCreate);

    unsub();
    store.openWidget();
    expect(spy.mock.calls.length).toBe(callsAfterCreate); // unsubscribed
  });

  it("returns a referentially stable snapshot until state changes", () => {
    const store = new ChatStore(makeFakeBackend().deps, makeMemoryPersistence());
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    expect(a).toBe(b);

    store.openWidget();
    const c = store.getSnapshot();
    expect(c).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// localStoragePersistence adapter
// ---------------------------------------------------------------------------

describe("localStoragePersistence", () => {
  it("round-trips through a Storage-like object", () => {
    const map = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as unknown as Storage;

    const p = localStoragePersistence(fakeStorage);
    p.write({ activeSessionId: "x", widgetOpen: true, minimized: false });

    expect(p.read()).toEqual({
      activeSessionId: "x",
      widgetOpen: true,
      minimized: false,
    });

    p.clear();
    expect(p.read()).toBeNull();
  });

  it("tolerates corrupt JSON and returns null", () => {
    const map = new Map<string, string>([["hermes.chat.v1", "{not json"]]);
    const fakeStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;
    expect(localStoragePersistence(fakeStorage).read()).toBeNull();
  });

  it("degrades to a null-op when no storage is available", () => {
    const p = localStoragePersistence(null);
    expect(() =>
      p.write({ activeSessionId: "x", widgetOpen: true, minimized: true }),
    ).not.toThrow();
    expect(p.read()).toBeNull();
  });
});
