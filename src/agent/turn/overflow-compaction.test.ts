import { describe, expect, it } from "vitest";
import { LlamaServerError } from "../../llm/llama-server-client.js";
import { GrammarError, TransportError } from "../../llm/reliability/llm-failures.js";
import { OpenAiHttpError } from "../../llm/provider/openai/openai-http.js";
import {
  ContextWindowExhaustedError,
  contextWindowExhaustedError,
  isConversationSizeRefusal,
  planOverflowCompaction,
} from "./overflow-compaction.js";

const SENTENCE = "llama-server returned http 400: the request exceeds the available context size, try increasing it";

/** The error as the loop sees a llama-server 400: the executor's GrammarError over it. */
function llamaOverflow(counts: { contextWindow?: number; promptTokens?: number } = {}): GrammarError {
  const cause = new LlamaServerError(SENTENCE, 400, "http://127.0.0.1:8080/completion", false, undefined,
    { body: { type: "exceed_context_size_error", ...counts } });
  return new GrammarError(SENTENCE, "", { cause });
}

const base = {
  attempted: false,
  aborted: false,
  canCompact: true,
  promptTokens: 6_000,
  believedWindow: 32_768 as number | null,
};

describe("planOverflowCompaction", () => {
  it("plans against the n_ctx the llama.cpp body names", () => {
    const plan = planOverflowCompaction({ ...base, error: llamaOverflow({ contextWindow: 8_192 }) });
    expect(plan).toMatchObject({ compactionWindow: 8_192, learnedWindow: 8_192, source: "provider", serverWindow: 8_192 });
  });

  it("scales the window when the server counted more tokens than the estimate", () => {
    const plan = planOverflowCompaction({
      ...base, error: llamaOverflow({ contextWindow: 8_192, promptTokens: 12_000 }),
    });
    // 8192 * 6000 / 12000: the history must fit in the agent's own units.
    expect(plan).toMatchObject({ compactionWindow: 4_096, learnedWindow: 8_192, source: "server_count", serverPromptTokens: 12_000 });
  });

  it("falls back to most of the estimate when nothing is named", () => {
    const plan = planOverflowCompaction({ ...base, error: llamaOverflow() });
    // A guess shapes this turn's compaction only; it is never remembered.
    expect(plan).toMatchObject({ compactionWindow: 4_800, learnedWindow: null, source: "estimate", serverWindow: null });
  });

  it("keeps the step's own window when the evidence is no smaller", () => {
    const plan = planOverflowCompaction({ ...base, believedWindow: 4_096, error: llamaOverflow({ contextWindow: 8_192 }) });
    expect(plan).toMatchObject({ compactionWindow: null, learnedWindow: null, source: "believed" });
    const unknown = planOverflowCompaction({ ...base, promptTokens: 0, error: llamaOverflow() });
    expect(unknown).toMatchObject({ compactionWindow: null, learnedWindow: null, source: "believed" });
  });

  it("reads an OpenAI-style refusal through the transport wrapper", () => {
    const error = new TransportError('"vendor" rejected the request (400).', 400, "https://x/v1", {
      cause: new OpenAiHttpError("openai provider 400: This model's maximum context length is 16384 tokens. However, you requested 20000 tokens.", 400, "u"),
    });
    expect(planOverflowCompaction({ ...base, error })).toMatchObject({ compactionWindow: 16_384, source: "provider" });
  });

  it("plans nothing once spent, when aborted, without compaction, or for other errors", () => {
    const error = llamaOverflow({ contextWindow: 8_192 });
    expect(planOverflowCompaction({ ...base, error, attempted: true })).toBeNull();
    expect(planOverflowCompaction({ ...base, error, aborted: true })).toBeNull();
    expect(planOverflowCompaction({ ...base, error, canCompact: false })).toBeNull();
    expect(planOverflowCompaction({ ...base, error: new Error("boom") })).toBeNull();
    const capOnly = new TransportError("rejected (400)", 400, "u", {
      cause: new OpenAiHttpError("openai provider 400: max_tokens is too large: 32768. This model supports at most 16384 completion tokens", 400, "u"),
    });
    expect(planOverflowCompaction({ ...base, error: capOnly })).toBeNull();
  });
});

describe("isConversationSizeRefusal", () => {
  const vllm = (body: string) => new TransportError('"vendor" rejected the request (400).', 400, "https://x/v1", {
    cause: new OpenAiHttpError(`openai provider 400: ${body}`, 400, "u"),
  });

  it("is true when the conversation itself outgrew the window", () => {
    expect(isConversationSizeRefusal(llamaOverflow({ contextWindow: 8_192, promptTokens: 9_134 }))).toBe(true);
    expect(isConversationSizeRefusal(llamaOverflow())).toBe(true);
    expect(isConversationSizeRefusal(vllm(
      "This model's maximum context length is 8192 tokens. However, you requested 9134 tokens (9000 in the messages, 134 in the completion).",
    ))).toBe(true);
  });

  it("is false when the reply reserve, not the conversation, is over", () => {
    expect(isConversationSizeRefusal(vllm(
      "This model's maximum context length is 8192 tokens. However, you requested 9134 tokens (1000 in the messages, 8134 in the completion).",
    ))).toBe(false);
    expect(isConversationSizeRefusal(llamaOverflow({ contextWindow: 8_192, promptTokens: 4_000 }))).toBe(false);
  });

  it("is false for anything but a context-size refusal", () => {
    expect(isConversationSizeRefusal(new Error("boom"))).toBe(false);
  });
});

describe("contextWindowExhaustedError", () => {
  it("names the window and the way out, keeping the server's sentence as cause", () => {
    const cause = llamaOverflow({ contextWindow: 8_192 });
    const error = contextWindowExhaustedError({ cause, compacted: true });
    expect(error).toBeInstanceOf(ContextWindowExhaustedError);
    expect(error.message).toBe(
      "The conversation no longer fits this model's context window (8,192 tokens), even after older history was compacted. " +
        "Start a new session, or load the model with a larger context size.",
    );
    expect((error as { cause?: unknown }).cause).toBe(cause);
  });

  it("says when nothing could be compacted and no window is known", () => {
    const error = contextWindowExhaustedError({ cause: llamaOverflow(), compacted: false });
    expect(error.message).toContain("this model's context window, and older history could not be compacted");
  });
});
