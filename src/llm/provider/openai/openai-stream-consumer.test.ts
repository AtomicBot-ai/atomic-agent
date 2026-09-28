import { describe, expect, it } from "vitest";

import {
  createOpenAiStreamConsumer,
  OpenAiSseError,
} from "./openai-stream-consumer.js";
import { readGenerationId } from "./generation-id.js";
import type { StreamFinalResult } from "../completion-types.js";

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolCallFrame(toolCalls: Array<Record<string, unknown>>): string {
  return sseFrame({
    model: "test-model",
    choices: [
      { index: 0, delta: { tool_calls: toolCalls }, finish_reason: null },
    ],
  });
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Drain the consumer and return the final result it returns on completion. */
async function drain(body: string): Promise<StreamFinalResult> {
  const consumer = createOpenAiStreamConsumer("delta_reasoning");
  const iterator = consumer.consume(bodyOf(body), undefined);
  for (;;) {
    const step = await iterator.next();
    if (step.done) return step.value as StreamFinalResult;
  }
}

/**
 * The same bytes as `bodyOf`, handed over one slice at a time so the
 * reader sees the socket's own chunk boundaries rather than one whole
 * body — including boundaries that fall inside a UTF-8 sequence, which
 * only `decoder.decode(value, { stream: true })` survives.
 */
function bodyOfSlices(
  text: string,
  cuts: readonly number[],
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const offsets = [0, ...cuts, bytes.length];
  const slices: Uint8Array[] = [];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    slices.push(bytes.subarray(offsets[i] as number, offsets[i + 1] as number));
  }
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = slices[sent];
        if (next === undefined) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(next);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Drain a body served in slices; returns the final result. */
async function drainSlices(
  text: string,
  cuts: readonly number[],
): Promise<{ result: StreamFinalResult; deltas: string[] }> {
  const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
    bodyOfSlices(text, cuts),
    undefined,
  );
  const deltas: string[] = [];
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { result: step.value as StreamFinalResult, deltas };
    if (step.value.delta.length > 0) deltas.push(step.value.delta);
  }
}

const DONE =
  sseFrame({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  }) + "data: [DONE]\n\n";

describe("openai stream consumer usage", () => {
  it("keeps a length finish_reason and reads usage from the trailing empty-choices chunk", async () => {
    // With `stream_options.include_usage`, OpenAI-style servers send the
    // usage block on one more chunk after the finish_reason, with an
    // empty `choices` array. Both must survive to the final result: the
    // cut is what fails the step, the counts are what explain it.
    const result = await drain(
      sseFrame({
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { content: "<think>still thinking" },
            finish_reason: null,
          },
        ],
      }) +
        sseFrame({
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        }) +
        sseFrame({
          model: "test-model",
          choices: [],
          usage: {
            prompt_tokens: 6100,
            completion_tokens: 8192,
            total_tokens: 14292,
          },
        }) +
        "data: [DONE]\n\n",
    );
    expect(result.finishReason).toBe("length");
    expect(result.terminalObserved).toBe(true);
    expect(result.usage).toEqual({
      promptTokens: 6100,
      completionTokens: 8192,
      totalTokens: 14292,
    });
  });
});

describe("openai stream consumer tool-call assembly", () => {
  it("keeps unindexed calls with distinct ids apart", async () => {
    const result = await drain(
      toolCallFrame([
        {
          id: "call_a",
          type: "function",
          function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
        },
      ]) +
        toolCallFrame([
          {
            id: "call_b",
            type: "function",
            function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
          },
        ]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
      },
    ]);
  });

  it("reassembles fragments of one unindexed call that repeats its id", async () => {
    const result = await drain(
      toolCallFrame([
        { id: "call_a", type: "function", function: { name: "os__fs__read" } },
      ]) +
        toolCallFrame([{ id: "call_a", function: { arguments: '{"path":' } }]) +
        toolCallFrame([{ id: "call_a", function: { arguments: '"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("still folds id-less continuation deltas into the open call", async () => {
    const result = await drain(
      toolCallFrame([
        { id: "call_a", type: "function", function: { name: "os__fs__read" } },
      ]) +
        toolCallFrame([{ function: { arguments: '{"path":"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("accumulates indexed parallel calls in index order, whatever the arrival order", async () => {
    const result = await drain(
      toolCallFrame([
        {
          index: 1,
          id: "call_b",
          type: "function",
          function: { name: "os__fs__grep", arguments: '{"pattern"' },
        },
      ]) +
        toolCallFrame([
          {
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "os__fs__read", arguments: '{"path"' },
          },
        ]) +
        toolCallFrame([{ index: 1, function: { arguments: ':"b"}' } }]) +
        toolCallFrame([{ index: 0, function: { arguments: ':"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
      },
    ]);
  });

  it("merges an id-only delta into the slot the provider opened by index", async () => {
    const result = await drain(
      toolCallFrame([
        {
          index: 0,
          id: "call_a",
          type: "function",
          function: { name: "os__fs__read" },
        },
      ]) +
        toolCallFrame([
          { id: "call_a", function: { arguments: '{"path":"a.txt"}' } },
        ]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("keeps two unindexed calls in a single event apart", async () => {
    const result = await drain(
      toolCallFrame([
        {
          id: "call_a",
          type: "function",
          function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
        },
      ]) + DONE,
    );

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.map((call) => call.id)).toEqual([
      "call_a",
      "call_b",
    ]);
  });
});

describe("openai stream consumer: text beside a tool-call delta", () => {
  it("keeps the text of a chunk that also carries a tool-call delta", async () => {
    // Gemini's compatibility layer and Anthropic shims put the model's
    // prose and its call in one event; the prose used to be dropped.
    const consumer = createOpenAiStreamConsumer("auto");
    const iterator = consumer.consume(
      bodyOf(
        sseFrame({
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: {
                content: "Reading the file. ",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "os__fs__read", arguments: '{"path":"a"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) + DONE,
      ),
      undefined,
    );
    const deltas: string[] = [];
    let final: StreamFinalResult | undefined;
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        final = step.value as StreamFinalResult;
        break;
      }
      deltas.push(step.value.delta);
    }
    expect(deltas.join("")).toBe("Reading the file. ");
    expect(final?.content).toBe("Reading the file. ");
    expect(final?.toolCalls).toMatchObject([
      { function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
    ]);
  });

  it("reads reasoning from any of the three fields under `auto`", async () => {
    for (const field of ["reasoning", "reasoning_content", "thinking"]) {
      const consumer = createOpenAiStreamConsumer("auto");
      const iterator = consumer.consume(
        bodyOf(
          sseFrame({
            model: "test-model",
            choices: [{ index: 0, delta: { [field]: "hmm" }, finish_reason: null }],
          }) + DONE,
        ),
        undefined,
      );
      let final: StreamFinalResult | undefined;
      for (;;) {
        const step = await iterator.next();
        if (step.done) {
          final = step.value as StreamFinalResult;
          break;
        }
      }
      expect(final?.reasoningContent).toBe("hmm");
    }
  });
});

describe("openai stream consumer chunk boundaries", () => {
  // A socket splits wherever it splits. The loop's incremental parse is
  // what makes that invisible, and these pin it: a cut that loses a
  // partial event, a partial JSON body or half a UTF-8 sequence is
  // silent content corruption, not a crash.
  const byteOffsetOf = (text: string, charIndex: number): number =>
    new TextEncoder().encode(text.slice(0, charIndex)).length;

  const TWO_FRAMES =
    sseFrame({
      id: "gen-split",
      model: "test-model",
      choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }],
    }) +
    sseFrame({
      model: "test-model",
      choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
    }) +
    DONE;

  it("keeps the content of a body cut inside a `data:` line", async () => {
    const { result, deltas } = await drainSlices(TWO_FRAMES, [
      3,
      TWO_FRAMES.indexOf("data:", 10) + 2,
    ]);
    expect(result.content).toBe("hello world");
    expect(deltas).toEqual(["hello ", "world"]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.generationId).toBe("gen-split");
    expect(result.terminalObserved).toBe(true);
  });

  it("keeps the content of a body cut inside a frame's JSON", async () => {
    const { result, deltas } = await drainSlices(TWO_FRAMES, [
      TWO_FRAMES.indexOf('"content"') + 5,
      TWO_FRAMES.indexOf("\n\n") + 1,
    ]);
    expect(result.content).toBe("hello world");
    expect(deltas).toEqual(["hello ", "world"]);
    expect(result.terminalObserved).toBe(true);
  });

  it("keeps a multi-byte character split across two reads", async () => {
    const text = "привет ✅";
    const body =
      sseFrame({
        model: "test-model",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }) + DONE;
    // One byte into the checkmark's three: a decoder without `stream:
    // true` (or a loop that decoded each read on its own) turns the tail
    // of this frame into replacement characters and breaks its JSON.
    const insideEmoji = byteOffsetOf(body, body.indexOf("✅")) + 1;
    const { result } = await drainSlices(body, [insideEmoji]);
    expect(result.content).toBe(text);
  });

  it("keeps tool-call arguments split across reads", async () => {
    const body =
      toolCallFrame([
        { index: 0, id: "call_1", type: "function", function: { name: "reply" } },
      ]) +
      toolCallFrame([{ index: 0, function: { arguments: '{"text":"ok' } }]) +
      toolCallFrame([{ index: 0, function: { arguments: '"}' } }]) +
      DONE;
    const { result } = await drainSlices(body, [
      body.indexOf('{\\"text') + 4,
      body.lastIndexOf("data:") - 1,
    ]);
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "reply", arguments: '{"text":"ok"}' },
      },
    ]);
  });
});

describe("openai stream consumer generation id (F29)", () => {
  it("carries the chunks' id on the final result", async () => {
    const result = await drain(
      sseFrame({
        id: "gen-abc123",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      }) + DONE,
    );
    expect(result.generationId).toBe("gen-abc123");
    expect(result.content).toBe("hi");
  });

  it("throws a typed error on a mid-stream error event, with the id and what streamed before it", async () => {
    // OpenRouter, run 14: `504 Upstream idle timeout` after 10,528 tokens.
    const body =
      sseFrame({
        id: "gen-504",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      }) +
      sseFrame({
        id: "gen-504",
        error: { code: 504, message: "Upstream idle timeout" },
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      });
    const consumer = createOpenAiStreamConsumer("delta_reasoning");
    const iterator = consumer.consume(bodyOf(body), undefined);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const err = await iterator.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiSseError);
    expect((err as OpenAiSseError).status).toBe(504);
    expect((err as OpenAiSseError).message).toBe("Upstream idle timeout");
    expect((err as OpenAiSseError).generationId).toBe("gen-504");
    expect(readGenerationId(err)).toBe("gen-504");
  });

  it("attaches the id to a body that died after output", async () => {
    const chunk = new TextEncoder().encode(
      sseFrame({
        id: "gen-dead",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "some" }, finish_reason: null }],
      }),
    );
    const dying = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
      },
      pull(controller) {
        controller.error(new Error("terminated"));
      },
    });
    const consumer = createOpenAiStreamConsumer("delta_reasoning");
    const iterator = consumer.consume(dying, undefined);
    await iterator.next();
    const err = await iterator.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("terminated");
    expect(readGenerationId(err)).toBe("gen-dead");
  });
});
