import { beforeEach, describe, expect, it, vi } from "vitest";

// `gatewayChatDeps` imports `@/lib/api` (browser fetch/session plumbing) and
// `@/lib/gatewayClient` (WebSocket). Mock both so the adapter logic — id
// selection, profile forwarding, single-flight connect, leak-free reconnect —
// can be exercised under the node test environment.

const getSessions = vi.fn();
const getSessionMessages = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    getSessions: (...a: unknown[]) => getSessions(...a),
    getSessionMessages: (...a: unknown[]) => getSessionMessages(...a),
  },
}));

/** A fake GatewayClient capturing requests and exposing controllable connect
 *  + state, so we can assert single-flight + dispose behaviour. */
class FakeClient {
  static instances: FakeClient[] = [];
  state: "idle" | "open" = "idle";
  closed = false;
  requests: Array<{ method: string; params: unknown }> = [];
  connectCalls = 0;
  private resolveConnect!: () => void;
  connectGate: Promise<void>;

  constructor() {
    FakeClient.instances.push(this);
    this.connectGate = new Promise<void>((r) => {
      this.resolveConnect = r;
    });
  }
  async connect() {
    this.connectCalls += 1;
    await this.connectGate;
    this.state = "open";
  }
  finishConnect() {
    this.resolveConnect();
  }
  close() {
    this.closed = true;
    this.state = "idle";
  }
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "session.create") {
      return Promise.resolve({
        session_id: "ephemeral123",
        stored_session_id: "stored-abc",
        title: null,
        info: { model: "anthropic/claude-x" },
      } as unknown as T);
    }
    return Promise.resolve({} as T);
  }
}

import { createGatewayChatDeps } from "@/lib/gatewayChatDeps";
import type { GatewayClient } from "@/lib/gatewayClient";

function makeDeps() {
  // FakeClient implements the subset of GatewayClient the adapter actually
  // uses (connect/close/request/state); cast through unknown for the factory.
  return createGatewayChatDeps(
    () => new FakeClient() as unknown as GatewayClient,
  );
}

describe("createGatewayChatDeps", () => {
  beforeEach(() => {
    FakeClient.instances = [];
    getSessions.mockReset();
    getSessionMessages.mockReset();
  });

  it("uses stored_session_id (not the ephemeral id) as the canonical id", async () => {
    const deps = makeDeps();
    const p = deps.createSession();
    FakeClient.instances[0]?.finishConnect();
    const created = await p;
    expect(created.id).toBe("stored-abc");
    expect(created.model).toBe("anthropic/claude-x");
  });

  it("forwards a requested profile into session.create params", async () => {
    const deps = makeDeps();
    const p = deps.createSession({ profile: "minerva" });
    FakeClient.instances[0]?.finishConnect();
    await p;
    const req = FakeClient.instances[0]?.requests.find(
      (r) => r.method === "session.create",
    );
    expect(req?.params).toEqual({ profile: "minerva" });
  });

  it("omits the profile param when none is requested", async () => {
    const deps = makeDeps();
    const p = deps.createSession();
    FakeClient.instances[0]?.finishConnect();
    await p;
    const req = FakeClient.instances[0]?.requests.find(
      (r) => r.method === "session.create",
    );
    expect(req?.params).toEqual({});
  });

  it("single-flights concurrent connects onto one client", async () => {
    const deps = makeDeps();
    // Fire two operations before the connection settles.
    const p1 = deps.createSession();
    const p2 = deps.createSession();
    // Exactly one client should have been constructed.
    expect(FakeClient.instances).toHaveLength(1);
    FakeClient.instances[0]?.finishConnect();
    await Promise.all([p1, p2]);
    expect(FakeClient.instances).toHaveLength(1);
    expect(FakeClient.instances[0]?.connectCalls).toBe(1);
  });

  it("delete targets the stored id via session.delete's session_id param", async () => {
    const deps = makeDeps();
    const p = deps.deleteSession("stored-xyz");
    FakeClient.instances[0]?.finishConnect();
    await p;
    const req = FakeClient.instances[0]?.requests.find(
      (r) => r.method === "session.delete",
    );
    expect(req?.params).toEqual({ session_id: "stored-xyz" });
  });

  it("maps REST session listings into ChatSession shape", async () => {
    getSessions.mockResolvedValue({
      sessions: [
        {
          id: "s1",
          title: "Hello",
          model: "m",
          started_at: 10,
          last_active: 20,
          preview: "hi",
          message_count: 3,
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const deps = makeDeps();
    const list = await deps.listSessions();
    expect(list).toEqual([
      {
        id: "s1",
        title: "Hello",
        profile: null,
        model: "m",
        createdAt: 10,
        lastActive: 20,
        preview: "hi",
        messageCount: 3,
      },
    ]);
  });

  it("maps REST messages into ChatMessage shape", async () => {
    getSessionMessages.mockResolvedValue({
      session_id: "s1",
      messages: [
        { role: "user", content: "q", timestamp: 5 },
        { role: "tool", content: "out", tool_name: "search" },
      ],
    });
    const deps = makeDeps();
    const msgs = await deps.loadMessages("s1");
    expect(msgs).toEqual([
      { role: "user", content: "q", timestamp: 5, toolName: undefined },
      { role: "tool", content: "out", timestamp: undefined, toolName: "search" },
    ]);
  });
});
