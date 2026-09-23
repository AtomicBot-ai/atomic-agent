import { describe, expect, it } from "vitest";

import { OpenAiHttpError } from "./openai-http.js";
import { isStructuredOutputRefusal } from "./structured-output-refusal.js";
import {
  OPENROUTER_PARAMETER_REFUSAL_BODY,
  openRouterRoutingFunnelBody as routingFunnel,
} from "./structured-output-refusal.fixture.js";

/** Build the error exactly as `httpErrorFromResponse` does: a 300-char preview. */
function httpError(status: number, body: string): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${body.slice(0, 300)}`,
    status,
    "https://openrouter.ai/api/v1/chat/completions",
    false,
    null,
    "openrouter",
  );
}

const errorBody = (message: string) => JSON.stringify({ error: { message } });

describe("isStructuredOutputRefusal", () => {
  it("reads OpenRouter's live 404 routing refusal through the 300-char preview", () => {
    expect(OPENROUTER_PARAMETER_REFUSAL_BODY.length).toBeGreaterThan(300);
    expect(
      isStructuredOutputRefusal(
        httpError(404, OPENROUTER_PARAMETER_REFUSAL_BODY),
      ),
    ).toBe(true);
  });

  it("reads the require_parameters 404 sentence as a refusal", () => {
    const body = errorBody(
      "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
    );
    expect(isStructuredOutputRefusal(httpError(404, body))).toBe(true);
  });

  it("does not blame parameters when the parameter step removed no endpoint", () => {
    expect(
      isStructuredOutputRefusal(httpError(404, routingFunnel([27, 27, 27, 0]))),
    ).toBe(false);
  });

  it.each([
    [
      "data-policy funnel",
      errorBody(
        "No endpoints found matching your data policy (Free model publication).",
      ),
    ],
    [
      "unknown model",
      errorBody("The model `z-ai/nope` does not exist or you do not have access."),
    ],
    ["bare 404", "Not Found"],
  ])("does not read a 404 %s as a refusal", (_label, body) => {
    expect(isStructuredOutputRefusal(httpError(404, body))).toBe(false);
  });

  it.each([
    [
      400,
      errorBody(
        "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
      ),
    ],
    [422, JSON.stringify({ detail: "Structured outputs are not supported." })],
    [400, errorBody("json_object response format is unavailable for this model")],
    [400, errorBody("Unsupported field: json_schema")],
  ])("reads a %i naming the feature as a refusal", (status, body) => {
    expect(isStructuredOutputRefusal(httpError(status, body))).toBe(true);
  });

  it("leaves the 'must contain the word json' 400 to the prompt, not the wire", () => {
    const body = errorBody(
      "<400> InternalError.Algo.InvalidParameter: 'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.",
    );
    expect(isStructuredOutputRefusal(httpError(400, body))).toBe(false);
  });

  it.each([
    [
      "context length that also names response_format",
      "Prompt plus response_format schema exceed the maximum context length of 32768 tokens.",
    ],
    [
      "context length",
      "This model's maximum context length is 32768 tokens. Please reduce the length of the messages.",
    ],
    ["invalid key", "API key not valid. Please pass a valid API key."],
  ])("does not read a 400 %s as a refusal", (_label, message) => {
    expect(isStructuredOutputRefusal(httpError(400, errorBody(message)))).toBe(
      false,
    );
  });

  it.each([401, 402, 403, 429, 500, 503])(
    "never reads a %i as a refusal, whatever the body says",
    (status) => {
      const body = errorBody("response_format json_schema is not supported");
      expect(isStructuredOutputRefusal(httpError(status, body))).toBe(false);
    },
  );

  it("never reads a network failure, our own timeout, or an untyped error as a refusal", () => {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    const wording = "response_format json_schema is not supported";
    expect(
      isStructuredOutputRefusal(new OpenAiHttpError(wording, null, url)),
    ).toBe(false);
    expect(
      isStructuredOutputRefusal(new OpenAiHttpError(wording, 400, url, true)),
    ).toBe(false);
    expect(isStructuredOutputRefusal(new Error(`400 ${wording}`))).toBe(false);
  });
});
