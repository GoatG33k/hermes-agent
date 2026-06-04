import { beforeEach, describe, expect, it, vi } from "vitest";

// `gatewayChatDeps` imports `@/lib/api` (browser fetch/session plumbing) and
// `@/lib/gatewayClient` (WebSocket). We mock `@/lib/api` because its functions
// are called directly. `@/lib/gatewayClient` is NOT mocked: the real module has
// no top-level side effects (it only imports the already-mocked `@/lib/api`),
// and the adapter never constructs the real client here — `makeDeps()` injects
// a FakeClient factory. This keeps the adapter logic (id selection, profile
// forwarding, single-flight connect, leak-free reconnect) testable under node.

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
  private rejectConnect!: (e: Error) => void;
  connectGate: Promise<void>;

  constructor() {
    FakeClient.instances.push(this);
    this.connectGate = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
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
  failConnect(e: Error) {
    this.rejectConnect(e);
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

  it("forwards a valid falsy (empty-string) profile id", async () => {
    const deps = makeDeps();
    const p = deps.createSession({ profile: "" });
    FakeClient.instances[0]?.finishConnect();
    await p;
    const req = FakeClient.instances[0]?.requests.find(
      (r) => r.method === "session.create",
    );
    expect(req?.params).toEqual({ profile: "" });
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

  it("on connect rejection: disposes the failed client and retries fresh", async () => {
    const deps = makeDeps();

    // First attempt: connect rejects → the call should reject, the failed
    // client must be closed, and `connecting` cleared.
    const p1 = deps.createSession();
    const first = FakeClient.instances[0]!;
    first.failConnect(new Error("ws down"));
    await expect(p1).rejects.toThrow("ws down");
    expect(first.closed).toBe(true);

    // Second attempt: a brand-new client is created (proving `connecting` and
    // `gw` were reset) and succeeds.
    const p2 = deps.createSession();
    expect(FakeClient.instances).toHaveLength(2);
    const second = FakeClient.instances[1]!;
    second.finishConnect();
    const created = await p2;
    expect(created.id).toBe("stored-abc");
    expect(second.closed).toBe(false);
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
