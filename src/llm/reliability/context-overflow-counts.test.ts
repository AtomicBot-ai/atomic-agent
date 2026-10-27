import { describe, expect, it } from "vitest";
import { readContextOverflowCounts } from "./context-overflow-counts.js";
import { readContextLengthFromRejection, readServerContextCounts } from "./request-size-rejection.js";
import { GrammarError } from "./llm-failures.js";
import { LlamaServerError, readLlamaErrorBody } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";

const LLAMA_BODY = JSON.stringify({
  error: {
    code: 400,
    message: "the request exceeds the available context size, try increasing it",
    type: "exceed_context_size_error",
    n_prompt_tokens: 9_134,
    n_ctx: 8_192,
  },
});

describe("readContextOverflowCounts", () => {
  it("reads n_ctx and n_prompt_tokens from a llama.cpp overflow body", () => {
    expect(readContextOverflowCounts(LLAMA_BODY)).toEqual({ contextWindow: 8_192, promptTokens: 9_134 });
  });

  it("returns nothing for bodies without the counts or that are not JSON", () => {
    expect(readContextOverflowCounts('{"error":{"type":"invalid_request_error"}}')).toEqual({});
    expect(readContextOverflowCounts("bad grammar")).toEqual({});
    expect(readContextOverflowCounts("")).toEqual({});
    expect(readContextOverflowCounts('{"error":{"n_ctx":-1,"n_prompt_tokens":"9"}}')).toEqual({});
  });
});

describe("llama-server overflow body on the error", () => {
  it("keeps the counts beside the reason code, never the message", () => {
    const body = readLlamaErrorBody(LLAMA_BODY);
    expect(body).toEqual({ type: "exceed_context_size_error", contextWindow: 8_192, promptTokens: 9_134 });
    expect(JSON.stringify(body)).not.toContain("try increasing it");
  });

  it("is what the loop reads when the sentence names no number", () => {
    const sentence = "llama-server returned http 400: the request exceeds the available context size, try increasing it";
    const cause = new LlamaServerError(sentence, 400, "http://127.0.0.1:8080/completion", false, undefined,
      { body: readLlamaErrorBody(LLAMA_BODY)! });
    const wrapped = new GrammarError(sentence, "", { cause });
    expect(readServerContextCounts(wrapped)).toEqual({ contextWindow: 8_192, promptTokens: 9_134 });
    expect(readContextLengthFromRejection(wrapped)).toBe(8_192);
  });

  it("reads the counts from an OpenAI-compatible entry's raw body too", () => {
    const err = new OpenAiHttpError("openai provider 400: the request exceeds the available context size", 400, "u",
      false, null, "", undefined, { body: parseProviderErrorBody(LLAMA_BODY) });
    expect(readServerContextCounts(err)).toEqual({ contextWindow: 8_192, promptTokens: 9_134 });
  });

  it("prefers the number in the sentence when an older build still writes it", () => {
    const err = new LlamaServerError(
      "llama-server returned http 400: request (5369 tokens) exceeds the available context size (4096 tokens), try increasing it",
      400, "u",
    );
    expect(readContextLengthFromRejection(err)).toBe(4_096);
    expect(readServerContextCounts(err)).toEqual({});
  });
});
