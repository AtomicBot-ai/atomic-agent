import { describe, expect, it } from "vitest";
import {
  isRequestSizeRejection,
  readContextLengthFromRejection,
  requestSizeRejectionNamesContext,
} from "./request-size-rejection.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { LlamaServerError } from "../llama-server-client.js";
import { TransportError } from "./llm-failures.js";

describe("isRequestSizeRejection", () => {
  it("recognises a cloud 400 that names the cap, as the provider phrases it", () => {
    expect(
      isRequestSizeRejection(
        new OpenAiHttpError(
          'openai provider 400: {"error":{"message":"max_tokens is too large: 32768. This model supports at most 16384 completion tokens"}}',
          400,
          "https://x/v1/chat/completions",
        ),
      ),
    ).toBe(true);
    expect(
      isRequestSizeRejection(
        new OpenAiHttpError(
          "openai provider 400: This model's maximum context length is 8192 tokens",
          400,
          "u",
        ),
      ),
    ).toBe(true);
  });

  it("reads through the humanized chat message to the provider's body on the cause", () => {
    const rejected = new TransportError(
      '"vendor" rejected the request (400).',
      400,
      "https://x/v1",
      {
        cause: new OpenAiHttpError(
          "openai provider 400: max_completion_tokens exceeds the limit",
          400,
          "u",
        ),
      },
    );
    expect(isRequestSizeRejection(rejected)).toBe(true);
  });

  it("recognises llama-server's own context-size refusal", () => {
    expect(
      isRequestSizeRejection(
        new LlamaServerError(
          "the request exceeds the available context size. try increasing the context size or enable context shift",
          400,
          "http://127.0.0.1:8080/completion",
        ),
      ),
    ).toBe(true);
  });

  it("does not mistake a body-shape 400 that merely names the field", () => {
    // OpenAI's o-series: a different link may accept the request as is,
    // so the chain must keep falling over on it.
    expect(
      isRequestSizeRejection(
        new OpenAiHttpError(
          "openai provider 400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          400,
          "u",
        ),
      ),
    ).toBe(false);
  });

  it("leaves every other failure alone", () => {
    expect(
      isRequestSizeRejection(new TransportError("bad request", 400, "")),
    ).toBe(false);
    expect(
      isRequestSizeRejection(
        new OpenAiHttpError(
          "openai provider 400: invalid tool schema",
          400,
          "u",
        ),
      ),
    ).toBe(false);
    expect(
      isRequestSizeRejection(new TransportError("max_tokens", 500, "")),
    ).toBe(false);
    expect(
      isRequestSizeRejection(new TransportError("max_tokens", null, "")),
    ).toBe(false);
    expect(isRequestSizeRejection(new Error("max_tokens"))).toBe(false);
  });
});

describe("readContextLengthFromRejection / requestSizeRejectionNamesContext (F30)", () => {
  const wrapped = (body: string) =>
    new TransportError('"vendor" rejected the request (400).', 400, "u", {
      cause: new OpenAiHttpError(`openai provider 400: ${body}`, 400, "u"),
    });

  it.each([
    [
      "This model's maximum context length is 8192 tokens. However, you requested 9134 tokens",
      8_192,
    ],
    [
      "This endpoint's maximum context length is 131,072 tokens. However, you requested about 140210 tokens",
      131_072,
    ],
    ["the model has a context length of only 4096 tokens", 4_096],
    ["prompt does not fit the 32768-token context window", 32_768],
    ["context window: 200000", 200_000],
  ])("reads the window out of %s", (body, expected) => {
    expect(readContextLengthFromRejection(wrapped(body))).toBe(expected);
    expect(requestSizeRejectionNamesContext(wrapped(body))).toBe(true);
  });

  it("never mistakes the requested count or the reply cap for the window", () => {
    expect(
      readContextLengthFromRejection(
        wrapped("the request exceeds the available context size. you requested 9000 tokens"),
      ),
    ).toBeNull();
    const cap = wrapped(
      "max_tokens is too large: 32768. This model supports at most 16384 completion tokens",
    );
    expect(readContextLengthFromRejection(cap)).toBeNull();
    expect(requestSizeRejectionNamesContext(cap)).toBe(false);
  });
});
