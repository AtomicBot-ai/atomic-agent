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

  it("throws when a chunk finishes with an error after content has streamed", async () => {
    // Gemini through OpenRouter: the prose before a function call, then the
    // call abandoned as MALFORMED_FUNCTION_CALL and no error object at all.
    // Taken as a stop, that prose became the assistant's answer.
    const body =
      sseFrame({
        id: "gen-malformed",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            index: 0,
            delta: { content: "I am delegating the implementation across 3 parallel tasks" },
            finish_reason: null,
          },
        ],
      }) +
      sseFrame({
        id: "gen-malformed",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            index: 0,
            delta: { content: "" },
            finish_reason: "error",
            native_finish_reason: "MALFORMED_FUNCTION_CALL",
          },
        ],
      }) +
      DONE;
    const consumer = createOpenAiStreamConsumer("delta_reasoning");
    const iterator = consumer.consume(bodyOf(body), undefined);
    let err: unknown;
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
      }
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(OpenAiSseError);
    expect((err as OpenAiSseError).status).toBe(502);
    expect((err as OpenAiSseError).message).toBe(
      "the provider ended the completion with an error (MALFORMED_FUNCTION_CALL)",
    );
    expect((err as OpenAiSseError).generationId).toBe("gen-malformed");
  });

  it("reads an error finish whatever case the service sends it in", async () => {
    const body =
      sseFrame({
        id: "gen-upper",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "half a sentence" }, finish_reason: null }],
      }) +
      sseFrame({
        id: "gen-upper",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "ERROR" }],
      }) +
      DONE;
    const consumer = createOpenAiStreamConsumer("delta_reasoning");
    const iterator = consumer.consume(bodyOf(body), undefined);
    const err = await (async () => {
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) return null;
        }
      } catch (caught) {
        return caught;
      }
    })();
    expect(err).toBeInstanceOf(OpenAiSseError);
    expect((err as OpenAiSseError).message).toBe(
      "the provider ended the completion with an error",
    );
  });

  it("leaves an error finish on the first event to the empty-completion path", async () => {
    // Nothing streamed yet, so the throw would land before the stream is
    // primed — where the fallback chain swaps links and arms a cooldown. An
    // empty completion is recovered in place instead (`isRecoverableEmptyCompletion`),
    // which is the right answer for a model that simply botched one call.
    const result = await drain(
      sseFrame({
        id: "gen-first-event",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            index: 0,
            delta: { content: "" },
            finish_reason: "error",
            native_finish_reason: "MALFORMED_FUNCTION_CALL",
          },
        ],
      }) + "data: [DONE]\n\n",
    );
    expect(result.content).toBe("");
    // No text and no tool call: exactly the shape the empty-completion
    // recovery is keyed on.
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe("error");
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

describe("openai stream consumer: a provider that just closes", () => {
  it("ends on a bare EOF, with a final finish_reason and no `[DONE]`", async () => {
    // The documented case — some OpenAI-compatible providers send a final
    // `finish_reason` and close without ever writing `[DONE]` — had no pin
    // in this file: `terminalObserved` was only ever asserted for a body
    // that does write it, or `false` for the early stop.
    //
    // Deliberately unbounded. Break the loop's exit on `done` and this does
    // not fail, it wedges: a read on a closed stream resolves immediately,
    // so the loop degenerates into a microtask loop that starves the timer
    // queue and with it vitest's own `testTimeout`. No in-process assertion
    // can catch that, which is the argument for having the case at all.
    const drained = await drain(
      sseFrame({
        id: "gen-eof",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "bye" }, finish_reason: "stop" }],
      }) + "\n",
    );
    expect(drained.content).toBe("bye");
    expect(drained.finishReason).toBe("stop");
    expect(drained.terminalObserved).toBe(true);
  });
});
