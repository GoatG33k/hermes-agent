/**
 * gatewayChatDeps — production wiring of `ChatStoreDeps` onto the real Hermes
 * backend (the `tui_gateway` JSON-RPC server + the REST `/api/sessions*`
 * endpoints).
 *
 * The store itself (see `chatStore.ts`) is transport-agnostic; this module is
 * the single place that knows how to:
 *
 *   - open / reuse a `GatewayClient` WebSocket,
 *   - call `session.create` (pinning a profile when one is requested),
 *   - call `session.delete`,
 *   - list sessions and read transcripts via the REST helpers in `lib/api`.
 *
 * Listing + transcript reads go through REST rather than the gateway because
 * those endpoints are the historical session browser (`/api/sessions`,
 * `/api/sessions/:id/messages`) and are cheaper than spinning gateway state.
 * Creation + deletion go through the gateway so the live agent runtime stays
 * in sync (a session created purely in the DB would have no running agent).
 */

import { api } from "@/lib/api";
import type { SessionInfo, SessionMessage } from "@/lib/api";
import { GatewayClient } from "@/lib/gatewayClient";
import type {
  ChatMessage,
  ChatSession,
  ChatStoreDeps,
} from "@/lib/chatStore";

/** How many sessions to fetch per listing. The chat registry rarely needs
 *  more, and the store re-sorts client-side regardless. */
const DEFAULT_SESSIONS_PAGE_SIZE = 100;

function toChatSession(s: SessionInfo): ChatSession {
  return {
    id: s.id,
    title: s.title,
    profile: s.profile_name ?? null,
    model: s.model,
    createdAt: s.started_at,
    lastActive: s.last_active,
    preview: s.preview,
    messageCount: s.message_count,
  };
}

function toChatMessage(m: SessionMessage): ChatMessage {
  return {
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    toolName: m.tool_name,
  };
}

/**
 * Build the production deps bag. A single lazily-connected `GatewayClient` is
 * shared for the app's lifetime; callers never see it.
 */
export function createGatewayChatDeps(
  // Injectable for tests: lets a fake client stand in for the real WebSocket
  // gateway. Production passes nothing and gets a real `GatewayClient`.
  makeClient: () => GatewayClient = () => new GatewayClient(),
): ChatStoreDeps {
  let gw: GatewayClient | null = null;
  // Maps stored_session_id → ephemeral gateway session_id.
  // prompt.submit uses the ephemeral id; the store tracks the stored id.
  const gwSidMap = new Map<string, string>();
  // Single-flight connect: while a connection is being established, concurrent
  // callers await the SAME promise instead of each spinning up (and tearing
  // down) their own client. Cleared once the connect settles.
  let connecting: Promise<GatewayClient> | null = null;

  async function gateway(): Promise<GatewayClient> {
    if (gw && gw.state === "open") return gw;
    if (connecting) return connecting;

    // Dispose any prior (closed/errored) client before replacing it so we
    // don't leak its socket + event listeners across reconnects.
    if (gw) {
      try {
        gw.close();
      } catch {
        /* already closed */
      }
      gw = null;
    }

    const client = makeClient();
    connecting = client
      .connect()
      .then(() => {
        gw = client;
        return client;
      })
      .catch((e) => {
        // Connect failed: dispose the partially-initialized client so we don't
        // leak its socket/listeners, and leave `gw` null so the next call
        // starts a fresh attempt. Re-throw so the caller sees the failure.
        try {
          client.close();
        } catch {
          /* already closed */
        }
        gw = null;
        throw e;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  return {
    async createSession(opts) {
      const client = await gateway();
      const params: Record<string, unknown> = {};
      // `profile` is forwarded so the config task (t_07e02f30 — "accept a
      // profile selection per session") can wire it through `session.create`.
      // The gateway ignores unknown params today, so this is forward-compatible
      // and harmless until that task lands. Use an explicit null/undefined check
      // (not truthiness) so a valid falsy profile id like "" is still forwarded.
      if (opts?.profile != null) params.profile = opts.profile;
      params.source = "chat_widget";
      const created = await client.request<{
        session_id: string;
        // The DB-backed session id (the `sessions.id` column). This is the id
        // space shared by `session.list`, `session.delete`, and the REST
        // `/api/sessions*` endpoints — verified against tui_gateway/server.py
        // (`session.delete` → `db.delete_session` deletes `WHERE id = ?`) and
        // hermes_state.py. We persist and operate on THIS id, not the
        // ephemeral in-process `session_id`, so the chat shows up in the
        // listing and its transcript / deletion target the right row.
        stored_session_id?: string;
        title?: string | null;
        info?: { model?: string | null };
      }>("session.create", params);
      const storedId = created.stored_session_id ?? created.session_id;
      gwSidMap.set(storedId, created.session_id);
      return {
        id: storedId,
        model: created.info?.model ?? null,
        title: created.title ?? null,
      };
    },

    async listSessions() {
      // Pull a healthy page; the chat list rarely needs more than this and the
      // store re-sorts client-side anyway.
      const page = await api.getSessions(DEFAULT_SESSIONS_PAGE_SIZE, 0, "chat_widget");
      return page.sessions.map(toChatSession);
    },

    async deleteSession(id) {
      const client = await gateway();
      // `id` is the stored `sessions.id` (see createSession's note). The
      // gateway's `session.delete` param is named `session_id` but operates on
      // this stored id (`db.delete_session` → `DELETE … WHERE id = ?`), so the
      // store's canonical id is exactly the right value to pass here.
      await client.request("session.delete", { session_id: id });
    },

    async loadMessages(id) {
      const res = await api.getSessionMessages(id);
      return res.messages.map(toChatMessage);
    },

    async listProfiles() {
      const res = await api.getProfiles();
      return res.profiles.map((p) => ({
        name: p.name,
        is_default: p.is_default,
        model: p.model ?? null,
        provider: p.provider ?? null,
      }));
    },

    async sendMessage(sessionId, content, handlers) {
      const client = await gateway();
      // Resolve the ephemeral gateway session_id from the stored session id.
      // If this session was loaded from history rather than created fresh in
      // this browser session, gwSidMap won't have it — spin up a new gateway
      // session so the agent is live and can handle the message.
      let gatewaySid = gwSidMap.get(sessionId);
      if (!gatewaySid) {
        const fresh = await client.request<{ session_id: string; stored_session_id?: string }>(
          "session.create",
          { source: "chat_widget" },
        );
        gatewaySid = fresh.session_id;
        gwSidMap.set(sessionId, gatewaySid);
      }

      await new Promise<void>((resolve, reject) => {
        // Guard against the agent-init session.info(running:false) that fires
        // right after session.create — only resolve once we've seen at least
        // one message.start, proving prompt.submit is actually executing.
        let turnStarted = false;

        const cleanup = () => {
          offTurnStart();
          offThinking();
          offDelta();
          offTurnComplete();
          offDone();
          offError();
        };

        const offTurnStart = client.on("message.start", (ev) => {
          if (ev.session_id !== gatewaySid) return;
          turnStarted = true;
          handlers.onTurnStart();
        });

        const offThinking = client.on<{ text?: string }>("thinking.delta", (ev) => {
          if (ev.session_id !== gatewaySid || !ev.payload?.text) return;
          handlers.onThinkingDelta(ev.payload.text);
        });

        const offDelta = client.on<{ text?: string }>("message.delta", (ev) => {
          if (ev.session_id !== gatewaySid || !ev.payload?.text) return;
          handlers.onDelta(ev.payload.text);
        });

        const offTurnComplete = client.on("message.complete", (ev) => {
          if (ev.session_id !== gatewaySid) return;
          handlers.onTurnComplete();
          // Do NOT resolve here — the agent may start another turn for tool calls.
        });

        // session.info { running: false } is the true "all turns done" signal,
        // emitted by the gateway in _run_prompt_submit's finally block after
        // every tool-call cycle finishes.
        const offDone = client.on<{ running?: boolean }>("session.info", (ev) => {
          if (ev.session_id !== gatewaySid) return;
          if (ev.payload?.running === false && turnStarted) {
            handlers.onDone();
            cleanup();
            resolve();
          }
        });

        const offError = client.on<{ message?: string }>("error", (ev) => {
          if (ev.session_id !== gatewaySid) return;
          const msg = ev.payload?.message ?? "unknown error";
          handlers.onError(msg);
          cleanup();
          reject(new Error(msg));
        });

        client
          .request("prompt.submit", { session_id: gatewaySid, text: content })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            handlers.onError(msg);
            cleanup();
            reject(e);
          });
      });
    },
  };
}
