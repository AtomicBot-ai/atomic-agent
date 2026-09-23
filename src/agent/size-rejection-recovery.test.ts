import { describe, expect, it } from "vitest";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import {
  composeSizeRejectionNotice,
  planSizeRejectionRepack,
  SIZE_REJECTION_NOTICE,
  SIZE_REJECTION_SHRINK,
} from "./size-rejection-recovery.js";

/** The error as the loop sees it: the executor's wrapper over the provider's 400. */
function rejection(body: string, status = 400): TransportError {
  return new TransportError(
    `"vendor" rejected the request (${status}).`,
    status,
    "https://x/v1",
    {
      cause: new OpenAiHttpError(`openai provider ${status}: ${body}`, status, "u"),
    },
  );
}

const OPENAI_CONTEXT =
  "This model's maximum context length is 8192 tokens. However, you requested 9134 tokens (7134 in the messages, 2000 in the completion). Please reduce the length of the messages or completion.";
const OPENROUTER_CONTEXT =
  '{"error":{"message":"This endpoint\'s maximum context length is 131072 tokens. However, you requested about 140210 tokens (130210 of text input, 10000 in the output). Please reduce the length of either one, or use the \\"middle-out\\" transform to compress your prompt automatically.","code":400}}';
const CAP_ONLY =
  "max_tokens is too large: 32768. This model supports at most 16384 completion tokens";

const base = {
  alreadyRetried: false,
  raisedCapRefused: false,
  transport: "native_tools" as const,
  promptTokens: 12_000,
  contextWindow: null,
  canFitWindow: true,
};

describe("planSizeRejectionRepack", () => {
  it("learns the window the provider named", () => {
    expect(
      planSizeRejectionRepack({ ...base, error: rejection(OPENAI_CONTEXT) }),
    ).toEqual({ contextWindow: 8_192, source: "provider" });
    expect(
      planSizeRejectionRepack({
        ...base,
        error: rejection(OPENROUTER_CONTEXT),
        contextWindow: 200_000,
      }),
    ).toEqual({ contextWindow: 131_072, source: "provider" });
  });

  it("falls back to most of the prompt estimate when the body names no number", () => {
    expect(
      planSizeRejectionRepack({
        ...base,
        error: rejection("the request exceeds the available context size", 413),
      }),
    ).toEqual({
      contextWindow: Math.floor(12_000 * SIZE_REJECTION_SHRINK),
      source: "estimate",
    });
  });

  it("uses the estimate when the named window is not below the believed one", () => {
    // The catalogue says 8192 already; the server still refused, so the
    // prompt estimate is what is off.
    expect(
      planSizeRejectionRepack({
        ...base,
        error: rejection(OPENAI_CONTEXT),
        contextWindow: 8_192,
        promptTokens: 8_500,
      }),
    ).toEqual({ contextWindow: 6_800, source: "estimate" });
  });

  it("plans nothing for a reply-cap refusal, which a smaller prompt cannot fix", () => {
    expect(planSizeRejectionRepack({ ...base, error: rejection(CAP_ONLY) })).toBeNull();
  });

  it("plans nothing when the refused request was the loop's own raised cap", () => {
    expect(
      planSizeRejectionRepack({
        ...base,
        error: rejection(OPENAI_CONTEXT),
        raisedCapRefused: true,
      }),
    ).toBeNull();
  });

  it("plans nothing on a grammar link, a second refusal, or with nowhere to learn to", () => {
    const error = rejection(OPENAI_CONTEXT);
    expect(planSizeRejectionRepack({ ...base, error, transport: "grammar" })).toBeNull();
    expect(planSizeRejectionRepack({ ...base, error, alreadyRetried: true })).toBeNull();
    expect(planSizeRejectionRepack({ ...base, error, canFitWindow: false })).toBeNull();
  });

  it("plans nothing when the estimate would be implausibly small or not below the belief", () => {
    const error = rejection("context size exceeded");
    expect(planSizeRejectionRepack({ ...base, error, promptTokens: 0 })).toBeNull();
    expect(planSizeRejectionRepack({ ...base, error, promptTokens: 900 })).toBeNull();
    expect(
      planSizeRejectionRepack({ ...base, error, promptTokens: 12_000, contextWindow: 9_000 }),
    ).toBeNull();
  });

  it("ignores errors that are not size rejections", () => {
    expect(
      planSizeRejectionRepack({
        ...base,
        error: new TransportError("fetch failed", null, ""),
      }),
    ).toBeNull();
  });
});

describe("composeSizeRejectionNotice", () => {
  it("keeps the notice the step already carried, first", () => {
    expect(composeSizeRejectionNotice(undefined)).toBe(SIZE_REJECTION_NOTICE);
    expect(composeSizeRejectionNotice("loop warning")).toBe(
      `loop warning\n\n${SIZE_REJECTION_NOTICE}`,
    );
  });
});
