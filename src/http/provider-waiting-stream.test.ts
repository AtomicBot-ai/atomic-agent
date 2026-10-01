import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * A parked turn has to reach the host.
 *
 * The agent has waited out provider outages since the outage work landed,
 * and the TUI shows a ticking readout while it does. Every other host — the
 * desktop app included — saw nothing between the last token and either a
 * recovery or a failure minutes later, because these two events stopped at
 * the loop. A window with no frames looks like a window with no agent, and
 * that is exactly what it was reported as.
 */
describe("provider_waiting over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;

  const waiting = {
    type: "provider_waiting" as const,
    attempt: 5,
    waitedMs: 65_000,
    maxWaitMs: 300_000,
    nextRetryMs: 30_000,
    reason: "fetch failed",
  };

  it("carries the attempt, how long it has waited and when it tries again", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))(waiting as never);
    expect(sse.written).toHaveLength(1);
    expect(sse.written[0]!.name).toBe("provider_waiting");
    expect(sse.written[0]!.payload).toMatchObject({
      session_id: "sess-1",
      attempt: 5,
      waited_ms: 65_000,
      max_wait_ms: 300_000,
      next_retry_ms: 30_000,
      reason: "fetch failed",
    });
  });

  it("says which link the turn waits on and what failed, when the loop knows", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))({
      ...waiting,
      cause: { kind: "unreachable" },
      providerId: "local-llama",
    } as never);
    expect(sse.written[0]!.payload).toMatchObject({
      reason: "fetch failed",
      cause: { kind: "unreachable" },
      provider_id: "local-llama",
    });

    const http = makeSse();
    buildStreamEventHook(http.writer as never, env(true))({
      ...waiting,
      reason: '"cloud" is having server trouble (503).',
      cause: { kind: "http", status: 503 },
    } as never);
    expect(http.written[0]!.payload).toMatchObject({
      cause: { kind: "http", status: 503 },
    });
    expect(http.written[0]!.payload).not.toHaveProperty("provider_id");
  });

  it("always carries cause as {kind, status?}: a status the provider never sent is left out", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))({
      ...waiting,
      cause: { kind: "stream_error", status: null },
      providerId: "openrouter",
    } as never);
    const payload = sse.written[0]!.payload as Record<string, unknown>;
    expect(payload.cause).toEqual({ kind: "stream_error" });
    expect(payload.provider_id).toBe("openrouter");

    const refused = makeSse();
    buildStreamEventHook(refused.writer as never, env(true))({
      ...waiting,
      cause: { kind: "refused" },
    } as never);
    expect(
      (refused.written[0]!.payload as Record<string, unknown>).cause,
    ).toEqual({ kind: "refused" });
  });

  it("leaves both out when the event has neither, as older hosts saw it", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))(waiting as never);
    expect(sse.written[0]!.payload).not.toHaveProperty("cause");
    expect(sse.written[0]!.payload).not.toHaveProperty("provider_id");
  });

  it("says when the provider came back, so the readout can stop", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))({
      type: "provider_recovered",
      waitedMs: 65_000,
    } as never);
    expect(sse.written[0]!.name).toBe("provider_recovered");
    expect(sse.written[0]!.payload).toMatchObject({ waited_ms: 65_000 });
  });

  it("stays off the wire for a plain OpenAI client, which would not know it", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));
    hook(waiting as never);
    hook({ type: "provider_recovered", waitedMs: 1 } as never);
    expect(sse.written).toHaveLength(0);
  });
});
