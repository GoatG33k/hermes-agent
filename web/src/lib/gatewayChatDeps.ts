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

function toChatSession(s: SessionInfo): ChatSession {
  return {
    id: s.id,
    title: s.title,
    profile: null, // server SessionInfo has no profile field today; config task fills this in
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
      return {
        id: created.stored_session_id ?? created.session_id,
        model: created.info?.model ?? null,
        title: created.title ?? null,
      };
    },

    async listSessions() {
      // Pull a healthy page; the chat list rarely needs more than this and the
      // store re-sorts client-side anyway.
      const page = await api.getSessions(100, 0);
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
  };
}
