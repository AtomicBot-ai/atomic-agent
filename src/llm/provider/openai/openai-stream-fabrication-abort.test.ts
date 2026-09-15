import { describe, expect, it, vi } from "vitest";

import type {
  CompletionResult,
  StreamChunk,
  StreamFinalResult,
} from "../completion-types.js";
import { STREAM_FABRICATION_ABORT_MIN_LINES } from "../../reliability/fabricated-tool-transcript.js";
import {
  FABRICATED_TRANSCRIPT_STOP,
  createOpenAiStreamConsumer,
} from "./openai-stream-consumer.js";
import { OpenAiProvider } from "./openai-provider.js";

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function contentFrame(content: string): string {
  return frame({
    model: "gemini-test",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function reasoningFrame(reasoning: string): string {
  return frame({
    model: "gemini-test",
    choices: [{ index: 0, delta: { reasoning }, finish_reason: null }],
  });
}

function toolCallFrame(
  index: number,
  id: string,
  name: string,
  args: string,
): string {
  return frame({
    model: "gemini-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index, id, type: "function", function: { name, arguments: args } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

const STOP_FRAMES =
  frame({
    model: "gemini-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }) + "data: [DONE]\n\n";

/** One fabricated transcript line per frame, the way Gemini streamed them. */
function transcriptFrames(lines: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const pair = Math.floor(i / 2);
    frames.push(
      contentFrame(
        i % 2 === 0
          ? `assistant_tool_call: os.fs.write {"path":"js/f${pair}.js","content":"export const x = ${pair};"}\n`
          : `tool_result[os.fs.write ok]: wrote 24 bytes to js/f${pair}.js\n`,
      ),
    );
  }
  return frames;
}

/**
 * A body served one frame per read, recording how far it was read and
 * whether — and why — it was cancelled. `highWaterMark: 0` so nothing is
 * pulled ahead of the reader: `pulled` is exactly what the consumer read.
 */
function trackedBody(frames: readonly string[]): {
  body: ReadableStream<Uint8Array>;
  state: { pulled: number; cancelled: boolean; reason: unknown };
} {
  const encoder = new TextEncoder();
  const state = { pulled: 0, cancelled: false, reason: undefined as unknown };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = frames[state.pulled];
        if (next === undefined) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(encoder.encode(next));
      },
      cancel(reason) {
        state.cancelled = true;
        state.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

async function drainConsumer(
  body: ReadableStream<Uint8Array>,
): Promise<{ chunks: StreamChunk[]; result: StreamFinalResult }> {
  const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(body);
  const chunks: StreamChunk[] = [];
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { chunks, result: step.value as StreamFinalResult };
    chunks.push(step.value);
  }
}

async function drainProvider(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<CompletionResult> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
  }
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function provider(
  fetchImpl: unknown,
  extra: { maxOutputTokens?: number; extraBody?: Record<string, unknown> } = {},
): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "gemini-test",
    fetchImpl: fetchImpl as typeof fetch,
    ...extra,
  });
}

describe("openai stream consumer: fabricated transcript abort", () => {
  it("cuts a fabricating stream at the sixth transcript line and cancels the body", async () => {
    // Request cloud-00312 streamed 45 such lines and ran to the provider's
    // limit (33,678 tokens, 297 s). Here the consumer stops reading after
    // the line that makes six.
    const frames = [
      contentFrame("I'll write the modules and run the tests.\n"),
      ...transcriptFrames(45),
      STOP_FRAMES,
    ];
    const { body, state } = trackedBody(frames);
    const { chunks, result } = await drainConsumer(body);

    expect(result.earlyStop).toEqual({
      reason: "fabricated_transcript",
      calls: 3,
      results: 3,
    });
    expect(result.finishReason).toBe(FABRICATED_TRANSCRIPT_STOP);
    // Not a provider terminal: nothing in the stream said it was over.
    expect(result.terminalObserved).toBe(false);
    expect(state.cancelled).toBe(true);
    expect(state.reason).toBe(FABRICATED_TRANSCRIPT_STOP);
    expect(state.pulled).toBe(1 + STREAM_FABRICATION_ABORT_MIN_LINES);
    expect(result.content.split("\n").filter(Boolean)).toHaveLength(
      1 + STREAM_FABRICATION_ABORT_MIN_LINES,
    );
    // The caller saw exactly what was read, then the done frame.
    expect(chunks.map((c) => c.delta).join("")).toBe(result.content);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  it("keeps a native call whose arguments had arrived and drops one still streaming", async () => {
    const frames = [
      toolCallFrame(0, "c1", "os__fs__read", '{"path":"js/scene.js"}'),
      toolCallFrame(1, "c2", "os__fs__write", '{"path":"js/main.js","cont'),
      ...transcriptFrames(10),
      STOP_FRAMES,
    ];
    const { body, state } = trackedBody(frames);
    const { result } = await drainConsumer(body);

    expect(result.earlyStop?.reason).toBe("fabricated_transcript");
    expect(state.cancelled).toBe(true);
    expect(result.toolCalls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"js/scene.js"}' },
      },
    ]);
  });

  it("does not cut long prose", async () => {
    const frames: string[] = [];
    for (let i = 0; i < 2_500; i += 1) {
      frames.push(
        contentFrame(
          `Paragraph ${i} explains that a \`tool_result[os.fs.read ok]:\` line is history, not output.\n`,
        ),
      );
    }
    frames.push(STOP_FRAMES);
    const { body, state } = trackedBody(frames);
    const { result } = await drainConsumer(body);

    expect(result.content.length).toBeGreaterThan(87_228);
    expect(result.earlyStop).toBeUndefined();
    expect(result.finishReason).toBe("stop");
    expect(result.terminalObserved).toBe(true);
    expect(state.cancelled).toBe(false);
  });

  it("does not cut a code-fenced example, even while its fence is still open", async () => {
    const frames = [
      contentFrame("Here is how the history is rendered:\n"),
      contentFrame("```text\n"),
      ...transcriptFrames(20),
      contentFrame("```\n"),
      contentFrame("That is the whole format.\n"),
      STOP_FRAMES,
    ];
    const { body, state } = trackedBody(frames);
    const { result } = await drainConsumer(body);

    expect(result.earlyStop).toBeUndefined();
    expect(result.finishReason).toBe("stop");
    expect(state.cancelled).toBe(false);
    expect(result.content).toContain("That is the whole format.");
  });

  it("never judges the reasoning channel", async () => {
    const lines = transcriptFrames(12).map((f) => {
      const payload = JSON.parse(f.slice("data: ".length)) as {
        choices: Array<{ delta: { content: string } }>;
      };
      return reasoningFrame(payload.choices[0]!.delta.content);
    });
    const frames = [...lines, contentFrame("Calling the tool now.\n"), STOP_FRAMES];
    const { body, state } = trackedBody(frames);
    const { result } = await drainConsumer(body);

    expect(result.earlyStop).toBeUndefined();
    expect(result.reasoningContent).toContain("tool_result[os.fs.write ok]");
    expect(state.cancelled).toBe(false);
  });
});

describe("OpenAiProvider: a stream cut for a fabricated transcript", () => {
  it("returns a finished completion — not truncated, not reopened", async () => {
    const tracked = trackedBody([
      contentFrame("Writing the files.\n"),
      ...transcriptFrames(45),
      STOP_FRAMES,
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(sseResponse(tracked.body));

    const result = await drainProvider(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(tracked.state.cancelled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.stop).toBe(true);
    expect(result.finishReason).toBe(FABRICATED_TRANSCRIPT_STOP);
    expect(result.earlyStop).toEqual({
      reason: "fabricated_transcript",
      calls: 3,
      results: 3,
    });
  });

  it("keeps a call that had arrived without marking the completion truncated", async () => {
    // No provider terminal ever arrives on a cut stream; the termination
    // safety net would otherwise read that as a cut tool call.
    const tracked = trackedBody([
      toolCallFrame(0, "c1", "os__fs__read", '{"path":"a.js"}'),
      ...transcriptFrames(6),
      STOP_FRAMES,
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(sseResponse(tracked.body));

    const result = await drainProvider(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(result.truncated).toBe(false);
    expect(result.toolCalls?.map((c) => c.function.name)).toEqual([
      "os__fs__read",
    ]);
  });
});

describe("OpenAiProvider: the reply cap the request carried", () => {
  function stopStream(): Response {
    return sseResponse(
      trackedBody([contentFrame("done\n"), STOP_FRAMES]).body,
    );
  }

  it("records null when no cap went on the wire", async () => {
    const fetchImpl = vi.fn(async () => stopStream());
    const result = await drainProvider(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );
    expect(result.sentMaxTokens).toBeNull();
  });

  it("records the request's own cap, else the provider ceiling, else a passthrough", async () => {
    const own = await drainProvider(
      provider(vi.fn(async () => stopStream())).completeStream({
        prompt: "hi",
        maxTokens: 32_768,
      }),
    );
    expect(own.sentMaxTokens).toBe(32_768);

    const ceiling = await drainProvider(
      provider(vi.fn(async () => stopStream()), {
        maxOutputTokens: 16_384,
      }).completeStream({ prompt: "hi" }),
    );
    expect(ceiling.sentMaxTokens).toBe(16_384);

    const passthrough = await drainProvider(
      provider(vi.fn(async () => stopStream()), {
        extraBody: { max_completion_tokens: 4_096 },
      }).completeStream({ prompt: "hi" }),
    );
    expect(passthrough.sentMaxTokens).toBe(4_096);
  });

  it("records it on the unary path too", async () => {
    const json = (): Response =>
      new Response(
        JSON.stringify({
          model: "gemini-test",
          choices: [
            { index: 0, message: { content: "hi" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const none = await provider(vi.fn(async () => json())).complete({
      prompt: "hi",
    });
    expect(none.sentMaxTokens).toBeNull();
    const capped = await provider(vi.fn(async () => json())).complete({
      prompt: "hi",
      maxTokens: 1_024,
    });
    expect(capped.sentMaxTokens).toBe(1_024);
  });
});
