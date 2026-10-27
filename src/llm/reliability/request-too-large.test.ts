import { describe, expect, it } from "vitest";
import { LlamaServerError } from "../llama-server-client.js";
import { isLlamaSizeRefusal, toRequestTooLargeError } from "./request-too-large.js";

const URL = "http://127.0.0.1:9931/completion";
const llama = (status: number, message: string, type?: string): LlamaServerError =>
  new LlamaServerError(message, status, URL, false, undefined, type !== undefined ? { body: { type } } : undefined);

describe("isLlamaSizeRefusal", () => {
  it("accepts a typed overflow 400 whatever its sentence says", () => {
    expect(isLlamaSizeRefusal(llama(400, "llama-server returned http 400", "exceed_context_size_error"))).toBe(true);
  });

  it("accepts a 413 and the size sentences of untyped 400s", () => {
    expect(isLlamaSizeRefusal(llama(413, "llama-server returned http 413"))).toBe(true);
    expect(isLlamaSizeRefusal(llama(400,
      "llama-server returned http 400: request (5369 tokens) exceeds the available context size (4096 tokens)"))).toBe(true);
    expect(isLlamaSizeRefusal(llama(400,
      "llama-server returned http 400: input is too large to process. increase the physical batch size"))).toBe(true);
  });

  it("rejects grammar and other 400s, and every other status", () => {
    expect(isLlamaSizeRefusal(llama(400, "llama-server returned http 400: Failed to parse grammar", "invalid_request_error"))).toBe(false);
    expect(isLlamaSizeRefusal(llama(400, "llama-server returned http 400"))).toBe(false);
    expect(isLlamaSizeRefusal(llama(422, "llama-server returned http 422: exceeds the context size"))).toBe(false);
    expect(isLlamaSizeRefusal(llama(500, "llama-server returned http 500: context size has been exceeded"))).toBe(false);
  });
});

describe("toRequestTooLargeError", () => {
  it("does not take a stray number for a window", () => {
    const err = toRequestTooLargeError(llama(400,
      "llama-server returned http 400: context size 12 exceeded", "exceed_context_size_error"));
    expect(err.contextWindow).toBeNull();
    expect(err.message.startsWith("The request does not fit the model's context window. ")).toBe(true);
  });
});
