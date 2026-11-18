import { describe, expect, it } from "vitest";
import { isInvalidParameterRejection } from "./invalid-parameter-rejection.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { TransportError } from "./llm-failures.js";

describe("isInvalidParameterRejection (ATO-1218)", () => {
  it("recognises a 400 / 422 that refuses a sampling setting", () => {
    expect(
      isInvalidParameterRejection(
        new OpenAiHttpError("openai provider 400: invalid temperature: only 1 is allowed", 400, "u"),
      ),
    ).toBe(true);
    expect(
      isInvalidParameterRejection(new OpenAiHttpError("openai provider 422: top_k must be >= 0", 422, "u")),
    ).toBe(true);
  });

  it("reads the provider's words off the cause and the body", () => {
    expect(
      isInvalidParameterRejection(
        new TransportError('"kimi" rejected the request (400).', 400, "u", {
          cause: new OpenAiHttpError("openai provider 400: invalid temperature", 400, "u"),
        }),
      ),
    ).toBe(true);
    expect(
      isInvalidParameterRejection(
        new OpenAiHttpError("openai provider 400: ", 400, "u", false, null, "", undefined, {
          body: { text: '{"error":{"message":"seed is not supported for this model"}}' },
        }),
      ),
    ).toBe(true);
  });

  it("is false for other statuses and other fields", () => {
    expect(
      isInvalidParameterRejection(new OpenAiHttpError("openai provider 500: invalid temperature", 500, "u")),
    ).toBe(false);
    expect(
      isInvalidParameterRejection(new OpenAiHttpError("openai provider 400: unsupported parameter: tools", 400, "u")),
    ).toBe(false);
    expect(isInvalidParameterRejection(new Error("invalid temperature"))).toBe(false);
  });
});
