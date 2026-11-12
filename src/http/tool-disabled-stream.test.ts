import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-1417: the server refused a tool's schema and the request went out
 * without it. A host that opted into extensions gets one named frame
 * with the chat sentence; the plain OpenAI stream stays as it was.
 */
describe("tool_disabled over SSE", () => {
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
  const event = {
    type: "tool_disabled" as const,
    stepIndex: 0,
    tool: "notion.search",
    reason: "schema_rejected" as const,
  };

  it("names the tool and carries the sentence for the chat", () => {
    const sse = makeSse();
    buildStreamEventHook(sse.writer as never, env(true))(event as never);
    expect(sse.written).toEqual([
      {
        name: "tool_disabled",
        payload: {
          object: "atomic.tool_disabled",
          session_id: "sess-1",
          step_index: 0,
          tool: "notion.search",
          reason: "schema_rejected",
          notice:
            "Tool notion.search is disabled for this turn: the model server did not accept its schema.",
        },
      },
    ]);
  });

  it("stays off the plain OpenAI stream", () => {
    const plain = makeSse();
    buildStreamEventHook(plain.writer as never, env(false))(event as never);
    expect(plain.written).toEqual([]);
  });
});
