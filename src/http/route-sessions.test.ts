import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { startTestHarness, type Harness } from "./test-harness.js";
import { MAX_PARKED_STEERS } from "./undelivered-steers.js";

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


/**
 * The other half of the steering promise: `200 {steered:true}` is
 * acceptance, not delivery, and the surface has to say so when the turn
 * ends without ever reading the message. Every steer here goes in
 * through the real `POST /api/sessions/{id}/steer` route while a real
 * turn holds the session lock — the loss this pins is the one a host
 * actually hits.
 */
describe("GET|DELETE /api/sessions/{id}/steer (undelivered)", () => {
  let harness: Harness;
  let sessionId: string;
  let steerStatus: number | null;
  /** What the stub steers from inside the final inference, in order. */
  let steerTexts: string[];

  function replyCompletion(text: string): CompletionResult {
    return {
      content: JSON.stringify({ tool: "reply", args: { text } }),
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: { promptMs: 0, predictedMs: 0, promptTokens: 4, predictedTokens: 2 },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: null,
    };
  }

  beforeEach(async () => {
    steerStatus = null;
    steerTexts = ["stop, summarise what you have instead"];
    harness = await startTestHarness({
      // Steer from inside the FINAL inference. The loop drains at the
      // top of a step; this turn replies on the step already running,
      // so no later boundary exists to drain it and the message comes
      // back on `RunTurnResult.undelivered`.
      llamaComplete: async ({ sessionId: turnSession, prompt }) => {
        // `### respond` marks a real agent step; the recall / reflection
        // helper prompts run on the same session id BEFORE the loop's
        // first drain, and steering from one of those would be
        // delivered normally instead of stranded.
        const agentStep = prompt.includes("### respond");
        if (turnSession === sessionId && agentStep && steerStatus === null) {
          for (const text of steerTexts) {
            const accepted = await fetch(
              `${harness.baseUrl}/api/sessions/${sessionId}/steer`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text }),
              },
            );
            steerStatus = accepted.status;
          }
        }
        return replyCompletion("done");
      },
    });
    sessionId = harness.runtime.createSession({
      metadata: { source: "undelivered" },
    }).id;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /** Run one turn that strands the steer, and assert it really did. */
  async function runStrandingTurn(): Promise<void> {
    const completion = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        messages: [{ role: "user", content: "go" }],
      }),
    });
    expect(completion.status).toBe(200);
    await completion.json();
    // The POST really was accepted — this is the `200 {steered:true}`
    // whose message used to be able to vanish.
    expect(steerStatus).toBe(200);
    // And the inbox is empty: `flushSteering` swept it on the way out,
    // so the text exists nowhere but the undelivered store.
    expect(harness.runtime.steeringInbox.peek(sessionId)).toEqual([]);
  }

  async function listUndelivered(): Promise<{
    sessionId: string;
    undelivered: Array<{ seq: number; text: string; parkedAt: number }>;
    discarded: number;
  }> {
    const response = await fetch(
      `${harness.baseUrl}/api/sessions/${sessionId}/steer`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      sessionId: string;
      undelivered: Array<{ seq: number; text: string; parkedAt: number }>;
      discarded: number;
    };
  }

  it("surfaces a steer the turn accepted but never delivered", async () => {
    await runStrandingTurn();
    const body = await listUndelivered();
    expect(body.sessionId).toBe(sessionId);
    expect(body.undelivered.map((e) => e.text)).toEqual(steerTexts);
    expect(body.undelivered[0]?.seq).toBeGreaterThan(0);
    expect(body.discarded).toBe(0);
  });

  it("returns nothing for a session whose turns delivered everything", async () => {
    const other = harness.runtime.createSession();
    const response = await fetch(
      `${harness.baseUrl}/api/sessions/${other.id}/steer`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: other.id,
      undelivered: [],
      discarded: 0,
    });
  });

  it("does not consume on read — a retried GET still finds the message", async () => {
    await runStrandingTurn();
    const first = await listUndelivered();
    const second = await listUndelivered();
    expect(second.undelivered).toEqual(first.undelivered);
  });

  it("lets the host resend the message and then ack it", async () => {
    await runStrandingTurn();
    const parked = await listUndelivered();
    const entry = parked.undelivered[0]!;

    // The resend is an ordinary completion carrying the parked text.
    steerStatus = -1; // stop the stub steering the resend turn as well
    const resend = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        messages: [{ role: "user", content: entry.text }],
      }),
    });
    expect(resend.status).toBe(200);
    const transcript = harness.runtime.sessionStore.load(sessionId);
    expect(
      transcript?.turns.some(
        (turn) => turn.kind === "user" && turn.text === entry.text,
      ),
    ).toBe(true);

    const acked = await fetch(
      `${harness.baseUrl}/api/sessions/${sessionId}/steer?through=${entry.seq}`,
      { method: "DELETE" },
    );
    expect(acked.status).toBe(200);
    expect(await acked.json()).toEqual({
      sessionId,
      acked: 1,
      remaining: 0,
      discardsAcked: 0,
      discarded: 0,
    });
    expect((await listUndelivered()).undelivered).toEqual([]);
  });

  it("acks by cursor, so a steer parked after the read survives", async () => {
    await runStrandingTurn();
    const seen = (await listUndelivered()).undelivered[0]!;
    // A second turn strands another message between the read and the
    // ack. A bare "clear" would swallow it unseen.
    steerStatus = null;
    steerTexts = ["and cancel the deploy"];
    await runStrandingTurn();

    const acked = await fetch(
      `${harness.baseUrl}/api/sessions/${sessionId}/steer?through=${seen.seq}`,
      { method: "DELETE" },
    );
    expect((await acked.json()) as unknown).toEqual({
      sessionId,
      acked: 1,
      remaining: 1,
      discardsAcked: 0,
      discarded: 0,
    });
    const left = await listUndelivered();
    expect(left.undelivered.map((e) => e.text)).toEqual([
      "and cancel the deploy",
    ]);
  });

  it("keeps the discard notice when the host acks the entries it was shown", async () => {
    // Fill the parking lot in one turn, then strand one more so the
    // per-session cap genuinely has to throw a message away.
    steerTexts = Array.from({ length: MAX_PARKED_STEERS }, (_, i) => `m${i}`);
    await runStrandingTurn();
    steerStatus = null;
    steerTexts = ["one too many"];
    await runStrandingTurn();

    const listed = await listUndelivered();
    expect(listed.undelivered).toHaveLength(MAX_PARKED_STEERS);
    expect(listed.discarded).toBe(1);

    // The host acks the highest seq it was given — which is all it can
    // do about the entries, and says nothing about the loss count.
    const acked = await fetch(
      `${harness.baseUrl}/api/sessions/${sessionId}/steer?through=${listed.undelivered.at(-1)!.seq}`,
      { method: "DELETE" },
    );
    expect((await acked.json()) as unknown).toEqual({
      sessionId,
      acked: MAX_PARKED_STEERS,
      remaining: 0,
      discardsAcked: 0,
      discarded: 1,
    });

    // ...and is still told a message was genuinely lost, rather than
    // being shown `discarded: 0` for a session that dropped one.
    const after = await listUndelivered();
    expect(after.undelivered).toEqual([]);
    expect(after.discarded).toBe(1);

    // The counter clears only through its own ack.
    const ackedDiscard = await fetch(
      `${harness.baseUrl}/api/sessions/${sessionId}/steer?discarded=1`,
      { method: "DELETE" },
    );
    expect((await ackedDiscard.json()) as unknown).toEqual({
      sessionId,
      acked: 0,
      remaining: 0,
      discardsAcked: 1,
      discarded: 0,
    });
    expect((await listUndelivered()).discarded).toBe(0);
  });

  it("rejects an ack without a usable cursor", async () => {
    await runStrandingTurn();
    for (const query of [
      "",
      "?through=",
      "?through=abc",
      "?through=-1",
      "?discarded=",
      "?discarded=abc",
      "?discarded=-1",
    ]) {
      const response = await fetch(
        `${harness.baseUrl}/api/sessions/${sessionId}/steer${query}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(400);
    }
    expect((await listUndelivered()).undelivered).toHaveLength(1);
  });

  it("drops parked steers when the session itself is purged", async () => {
    await runStrandingTurn();
    expect((await listUndelivered()).undelivered).toHaveLength(1);
    const deleted = await fetch(
      `${harness.baseUrl}/api/sessions/${sessionId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect((await listUndelivered()).undelivered).toEqual([]);
  });
});
