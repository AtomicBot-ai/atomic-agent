import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-2004/2005: when the loop guard trips, a host that opted into
 * extensions gets one named frame, so it can mark the summary reply that
 * follows without matching its text. Warn and critical levels send none,
 * and the plain OpenAI stream stays as it was.
 */
describe("loop_stopped over SSE", () => {
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
  const breaker = {
    type: "loop_detected" as const,
    tool: "os.web.fetch",
    count: 12,
    stepIndex: 11,
    level: "breaker" as const,
    detector: "wandering" as const,
  };

  it("sends one frame naming the stopped tool on a breaker", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))(breaker as never);
    expect(sse.written).toEqual([
      {
        name: "loop_stopped",
        payload: {
          object: "atomic.loop_stopped",
          session_id: "sess-1",
          step_index: 11,
          tool: "os.web.fetch",
          detector: "wandering",
        },
      },
    ]);
  });

  it("sends nothing for warn or critical, or on the plain stream", () => {
    for (const level of ["warn", "critical"] as const) {
      const sse = makeSse();
      buildStreamEventHook(sse.writer as never, env(true))({ ...breaker, level } as never);
      expect(sse.written.filter((w) => w.name === "loop_stopped")).toEqual([]);
    }
    const plain = makeSse();
    buildStreamEventHook(plain.writer as never, env(false))(breaker as never);
    expect(plain.written).toEqual([]);
  });
});
