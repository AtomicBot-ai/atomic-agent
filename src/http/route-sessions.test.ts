import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("/api/sessions", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("lists sessions scoped to the runtime working directory", async () => {
    const a = harness.runtime.createSession({ metadata: { kind: "a" } });
    const b = harness.runtime.createSession({ metadata: { kind: "b" } });
    const response = await fetch(`${harness.baseUrl}/api/sessions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>;
    };
    const ids = body.sessions.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("returns the full session state for a known id", async () => {
    const session = harness.runtime.createSession();
    const response = await fetch(
      `${harness.baseUrl}/api/sessions/${session.id}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      turns: unknown[];
      metadata: Record<string, unknown>;
    };
    expect(body.id).toBe(session.id);
    expect(Array.isArray(body.turns)).toBe(true);
  });

  it("returns 404 for an unknown session id", async () => {
    const response = await fetch(`${harness.baseUrl}/api/sessions/missing`);
    expect(response.status).toBe(404);
  });

  it("deletes a session idempotently", async () => {
    const session = harness.runtime.createSession();
    const first = await fetch(`${harness.baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(first.status).toBe(200);
    expect(harness.runtime.sessionStore.load(session.id)).toBeNull();
    const second = await fetch(`${harness.baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(second.status).toBe(200);
  });
});

describe("POST /api/sessions/{id}/steer", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function steer(
    sessionId: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(`${harness.baseUrl}/api/sessions/${sessionId}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Hold the session lock so `turnController.isBusy` is true. */
  async function whileBusy<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const held = new Promise<void>((res) => {
      release = res;
    });
    let result!: T;
    const turn = harness.runtime.turnController.enqueue({
      sessionId,
      origin: "http",
      run: async () => {
        result = await fn();
        release();
        await held;
        return null;
      },
    });
    await turn;
    return result;
  }

  it("accepts a steer while the session has a turn in flight", async () => {
    const session = harness.runtime.createSession();
    const response = await whileBusy(session.id, () =>
      steer(session.id, { text: "actually, stop and summarise" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      steered: true,
      sessionId: session.id,
    });
    expect(harness.runtime.steeringInbox.peek(session.id)).toEqual([
      "actually, stop and summarise",
    ]);
  });

  it("409s on an idle session instead of silently swallowing the message", async () => {
    const session = harness.runtime.createSession();
    const response = await steer(session.id, { text: "anyone home?" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("/v1/chat/completions");
    expect(harness.runtime.steeringInbox.peek(session.id)).toEqual([]);
  });

  it("409s for a session id that never existed", async () => {
    const response = await steer("s-nope", { text: "hello" });
    expect(response.status).toBe(409);
  });

  it("rejects a missing or blank text", async () => {
    const session = harness.runtime.createSession();
    expect((await steer(session.id, {})).status).toBe(400);
    expect((await steer(session.id, { text: "   " })).status).toBe(400);
    expect((await steer(session.id, { text: 42 })).status).toBe(400);
  });

  it("429s once the per-session inbox is full", async () => {
    const session = harness.runtime.createSession();
    const statuses = await whileBusy(session.id, async () => {
      const out: number[] = [];
      // 16 fit (MAX_PENDING_STEERS); the 17th must be refused rather
      // than evicting one the operator already saw accepted.
      for (let i = 0; i < 17; i += 1) {
        out.push((await steer(session.id, { text: `m${i}` })).status);
      }
      return out;
    });
    expect(statuses.slice(0, 16).every((s) => s === 200)).toBe(true);
    expect(statuses[16]).toBe(429);
  });
});

