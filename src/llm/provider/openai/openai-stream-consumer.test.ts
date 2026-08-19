import { describe, expect, it } from "vitest";

import { createOpenAiStreamConsumer } from "./openai-stream-consumer.js";
import type { StreamFinalResult } from "../completion-types.js";

/** An SSE body carrying one `data:` line per event, then `[DONE]`. */
function sseBody(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = [
    ...events.map((e) => `data: ${JSON.stringify(e)}\n\n`),
    "data: [DONE]\n\n",
  ];
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function toolCallDelta(
  index: number,
  fn: { name?: string; arguments?: string },
  extra: Record<string, unknown> = {},
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index, function: fn, ...extra }] },
      },
    ],
  };
}

async function drain(
  body: ReadableStream<Uint8Array>,
): Promise<StreamFinalResult> {
  const consumer = createOpenAiStreamConsumer("none");
  const it = consumer.consume(body, new AbortController().signal);
  let last: IteratorResult<unknown, StreamFinalResult>;
  do {
    last = (await it.next()) as IteratorResult<unknown, StreamFinalResult>;
  } while (!last.done);
  return last.value;
}

describe("openai stream consumer — tool call names", () => {
  it("keeps the name whole when the gateway repeats it in every chunk", async () => {
    // AI/ML API fronting Anthropic does exactly this. Concatenating turned
    // `reply` into `replyreplyreplyreplyreply`, and the agent then refused
    // its own protocol tool with "tool not registered in this agent".
    const result = await drain(
      sseBody([
        toolCallDelta(0, { name: "reply", arguments: '{"text"' }, {
          id: "call_1",
          type: "function",
        }),
        toolCallDelta(0, { name: "reply", arguments: ':"hi' }),
        toolCallDelta(0, { name: "reply", arguments: ' there"}' }),
        { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
      ]),
    );
    expect(result.toolCalls?.[0]?.function.name).toBe("reply");
    expect(result.toolCalls?.[0]?.function.arguments).toBe(
      '{"text":"hi there"}',
    );
  });

  it("takes the spec shape, where the name arrives once", async () => {
    const result = await drain(
      sseBody([
        toolCallDelta(0, { name: "os.fs.read", arguments: "{}" }, {
          id: "call_1",
          type: "function",
        }),
        { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
      ]),
    );
    expect(result.toolCalls?.[0]?.function.name).toBe("os.fs.read");
  });

  it("still assembles a name that is genuinely split across chunks", async () => {
    const result = await drain(
      sseBody([
        toolCallDelta(0, { name: "os.fs" }, { id: "c", type: "function" }),
        toolCallDelta(0, { name: ".read", arguments: "{}" }),
        { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
      ]),
    );
    expect(result.toolCalls?.[0]?.function.name).toBe("os.fs.read");
  });

  it("assembles a split that ends in the name's doubled last letter", async () => {
    // `os.proc.kil` + `l`. The fragment is a suffix of what we already
    // hold, so dropping partial repeats left `os.proc.kil` — a name no
    // registry has. Every tool whose name ends in a doubled letter
    // (`os.proc.kill`, `browser.scroll`, `memory.*.recall`) splits this
    // way, so the suffix signal is loss, not de-duplication.
    const result = await drain(
      sseBody([
        toolCallDelta(0, { name: "os.proc.kil" }, { id: "c", type: "function" }),
        toolCallDelta(0, { name: "l", arguments: "{}" }),
        { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
      ]),
    );
    expect(result.toolCalls?.[0]?.function.name).toBe("os.proc.kill");
  });

  it("keeps parallel calls apart when both repeat their names", async () => {
    const result = await drain(
      sseBody([
        toolCallDelta(0, { name: "os.fs.read", arguments: "{}" }, { id: "a" }),
        toolCallDelta(1, { name: "os.shell.run", arguments: "{}" }, { id: "b" }),
        toolCallDelta(0, { name: "os.fs.read" }),
        toolCallDelta(1, { name: "os.shell.run" }),
        { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
      ]),
    );
    expect(result.toolCalls?.map((c) => c.function.name)).toEqual([
      "os.fs.read",
      "os.shell.run",
    ]);
  });
});
