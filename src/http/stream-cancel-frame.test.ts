import { describe, expect, it } from "vitest";

import { attachFailedAttempts } from "../llm/fallback/failed-attempts.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * A cancelled turn is reported as cancelled. `loop_failed` usually names
 * the first link the fallback chain recorded — the provider the operator
 * picked — but a turn the user stopped did not end because of anything
 * the chain went through before the stop.
 */
describe("loop_failed for a cancelled turn over SSE", () => {
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

  const stoppedAfterAFallover = (): Error => {
    const stop = new Error("This operation was aborted");
    attachFailedAttempts(stop, [
      { providerId: "openrouter", error: new TypeError("fetch failed") },
    ]);
    return stop;
  };

  it("says cancelled, not the primary's earlier transport failure", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({
      type: "loop_failed",
      error: stoppedAfterAFallover(),
      category: "cancelled",
    } as never);

    expect(sse.written).toEqual([
      {
        name: "error",
        payload: { error: "This operation was aborted", category: "cancelled" },
      },
    ]);
  });

  it("says cancelled to an OpenAI-compatible client too", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));

    hook({
      type: "loop_failed",
      error: stoppedAfterAFallover(),
      category: "cancelled",
    } as never);

    expect(sse.written).toHaveLength(1);
    const payload = JSON.stringify(sse.written[0]!.payload);
    expect(payload).toContain("agent.cancelled");
    expect(payload).not.toContain("fetch failed");
  });
});
