import { describe, expect, it } from "vitest";

import { attachFailedAttempts } from "../llm/fallback/failed-attempts.js";
import { classifyFailure } from "../llm/reliability/index.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * Which failure an HTTP host is told about.
 *
 * `runWithFallback` throws the LAST link's error untouched — it decides
 * classification and the outage wait — and records the links that failed
 * before it beside it. On the common chain [cloud provider, auto-appended
 * llama-server] the last link is a daemon that never ran, so a host that
 * shows one sentence per failed turn (the desktop app) must be given the
 * provider the operator picked: its refusal, in its own words, and its own
 * category — not the tail's `fetch failed`, which the desktop renders as
 * "<provider> is not answering" for a provider that answered.
 */
describe("loop_failed over SSE", () => {
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

  const refusal = () =>
    Object.assign(
      new Error(
        "openrouter rejected the request (402): This request requires more credits, or fewer max_tokens.",
      ),
      { status: 402 },
    );

  it("names the provider the operator picked when the chain fell over before failing", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    const primary = refusal();
    const tail = new TypeError("fetch failed");
    attachFailedAttempts(tail, [{ providerId: "openrouter", error: primary }]);

    hook({ type: "loop_failed", error: tail, category: classifyFailure(tail) } as never);

    expect(sse.written).toHaveLength(1);
    const frame = sse.written[0]!;
    expect(frame.name).toBe("error");
    const payload = frame.payload as { error: string; category?: string; fallback_failures?: unknown };
    expect(payload.error).toBe(primary.message);
    expect(payload.category).toBe(classifyFailure(primary));
    expect(payload.category).not.toBe("transport");
    expect(payload.fallback_failures).toEqual([
      { providerId: "openrouter", reason: primary.message },
    ]);
  });

  it("reports a single-link failure exactly as before", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    const only = new TypeError("fetch failed");

    hook({ type: "loop_failed", error: only, category: classifyFailure(only) } as never);

    expect(sse.written).toEqual([
      { name: "error", payload: { error: "fetch failed", category: "transport" } },
    ]);
  });

  it("gives an OpenAI-compatible client the primary's message in the standard envelope", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));
    const primary = refusal();
    const tail = new TypeError("fetch failed");
    attachFailedAttempts(tail, [{ providerId: "openrouter", error: primary }]);

    hook({ type: "loop_failed", error: tail, category: classifyFailure(tail) } as never);

    expect(sse.written).toHaveLength(1);
    const frame = sse.written[0]!;
    expect(frame.name).toBeNull();
    expect(JSON.stringify(frame.payload)).toContain("requires more credits");
    expect(JSON.stringify(frame.payload)).not.toContain("fallback_failures");
  });
});
