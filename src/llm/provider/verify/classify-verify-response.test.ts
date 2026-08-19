import { describe, expect, it } from "vitest";

import { OpenAiHttpError } from "../openai/openai-http.js";
import {
  classifyVerifyResponse,
  classifyVerifyTransportError,
} from "./classify-verify-response.js";

describe("classifyVerifyResponse", () => {
  it("treats any 2xx as proof the key is live and funded", () => {
    expect(classifyVerifyResponse(200, "{}")).toEqual({
      kind: "status",
      status: "ok",
    });
  });

  it("reads 402 as an empty account", () => {
    expect(classifyVerifyResponse(402, "Payment Required")).toEqual({
      kind: "status",
      status: "no_balance",
    });
  });

  it("separates a dead key from a drained one on 401/403", () => {
    expect(classifyVerifyResponse(401, "No auth credentials found")).toEqual({
      kind: "status",
      status: "invalid_key",
    });
    // Prepaid services answer 403 with a perfectly valid key once the
    // credit is gone; refusing it as "wrong key" would send the operator
    // hunting for a new one.
    expect(
      classifyVerifyResponse(403, '{"error":"insufficient credits"}'),
    ).toEqual({ kind: "status", status: "no_balance" });
  });

  it("keeps a bare 429 soft and a quota 429 hard", () => {
    expect(classifyVerifyResponse(429, "slow down")).toEqual({
      kind: "status",
      status: "rate_limited",
    });
    expect(
      classifyVerifyResponse(429, '{"error":{"code":"insufficient_quota"}}'),
    ).toEqual({ kind: "status", status: "no_balance" });
  });

  it("reads Gemini's 400 for a bad key as a bad key", () => {
    // The OpenAI-compatible Gemini surface answers 400 INVALID_ARGUMENT
    // where every other service answers 401.
    expect(
      classifyVerifyResponse(
        400,
        '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
      ),
    ).toEqual({ kind: "status", status: "invalid_key" });
  });

  it("asks for the other token field instead of blaming the key", () => {
    expect(
      classifyVerifyResponse(
        400,
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      ),
    ).toEqual({ kind: "retry_token_field" });
  });

  it("moves to the next candidate when the model is the problem", () => {
    expect(classifyVerifyResponse(404, "no such model")).toEqual({
      kind: "retry_next_model",
    });
    expect(
      classifyVerifyResponse(400, '{"error":"The model `x` does not exist"}'),
    ).toEqual({ kind: "retry_next_model" });
  });

  it("falls back to a provider fault for anything else", () => {
    expect(classifyVerifyResponse(503, "upstream unavailable")).toEqual({
      kind: "status",
      status: "provider_error",
    });
  });
});

describe("classifyVerifyTransportError", () => {
  it("tells our own deadline apart from an unreachable host", () => {
    const timedOut = new OpenAiHttpError("t", null, "u", true, null, "p");
    expect(classifyVerifyTransportError(timedOut)).toBe("timeout");

    const network = new OpenAiHttpError("n", null, "u", false, null, "p");
    expect(classifyVerifyTransportError(network)).toBe("unreachable");
  });

  it("reports an abort as a cancellation", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyVerifyTransportError(abort)).toBe("cancelled");
  });
});
