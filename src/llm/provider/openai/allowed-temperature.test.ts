import { describe, expect, it } from "vitest";

import {
  allowedTemperatureFromError,
  parseAllowedTemperature,
  parseTemperatureRefused,
  temperatureLessonFromError,
} from "./allowed-temperature.js";
import { OpenAiHttpError } from "./openai-http.js";

const MOONSHOT_400 =
  '{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}}';

describe("parseAllowedTemperature", () => {
  it("reads the value Moonshot names", () => {
    expect(parseAllowedTemperature(MOONSHOT_400)).toBe(1);
    expect(
      parseAllowedTemperature("temperature: only 0.6 is allowed for this model"),
    ).toBe(0.6);
  });

  it("ignores the phrasing when temperature is not the subject", () => {
    expect(
      parseAllowedTemperature("invalid n: only 1 is allowed for this model"),
    ).toBeUndefined();
  });

  it("ignores other 400 bodies and out-of-range values", () => {
    expect(parseAllowedTemperature("Unsupported parameter: 'temperature'")).toBeUndefined();
    expect(parseAllowedTemperature("temperature: only 7 is allowed")).toBeUndefined();
  });
});

describe("allowedTemperatureFromError", () => {
  it("reads only a 400", () => {
    const at = (status: number) =>
      allowedTemperatureFromError(
        new OpenAiHttpError(`openai provider ${status}: ${MOONSHOT_400}`, status, "u"),
      );
    expect(at(400)).toBe(1);
    expect(at(500)).toBeUndefined();
    expect(allowedTemperatureFromError("only 1 is allowed")).toBeUndefined();
  });
});

const ANTHROPIC_400 =
  '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}';

describe("parseTemperatureRefused (ATO-1397)", () => {
  it("reads Anthropic's and OpenAI's refusals", () => {
    expect(parseTemperatureRefused(ANTHROPIC_400)).toBe(true);
    expect(parseTemperatureRefused("Unsupported parameter: 'temperature' is not supported with this model.")).toBe(true);
    expect(parseTemperatureRefused("temperature is not supported for this model")).toBe(true);
  });

  it("ignores other deprecations and the allowed-value phrasing", () => {
    expect(parseTemperatureRefused("`max_tokens` is deprecated for this model")).toBe(false);
    expect(parseTemperatureRefused(MOONSHOT_400)).toBe(false);
    expect(parseTemperatureRefused("invalid max_tokens")).toBe(false);
  });
});

describe("temperatureLessonFromError", () => {
  const err = (body: string, status = 400) =>
    new OpenAiHttpError(`anthropic provider ${status}: ${body}`, status, "u");

  it("says omit for a refusal, the value for a named one, nothing otherwise", () => {
    expect(temperatureLessonFromError(err(ANTHROPIC_400))).toBe("omit");
    expect(temperatureLessonFromError(err(MOONSHOT_400))).toBe(1);
    expect(temperatureLessonFromError(err(ANTHROPIC_400, 500))).toBeUndefined();
    expect(temperatureLessonFromError(err('{"error":"bad"}'))).toBeUndefined();
  });
});
