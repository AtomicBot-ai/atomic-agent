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

const ANTHROPIC_DEPRECATED_400 =
  '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}';

describe("parseTemperatureRefused (ATO-1397)", () => {
  it("reads a refusal of the field itself", () => {
    expect(parseTemperatureRefused(ANTHROPIC_DEPRECATED_400)).toBe(true);
    expect(
      parseTemperatureRefused(
        "Unsupported parameter: 'temperature' is not supported with this model.",
      ),
    ).toBe(true);
    expect(parseTemperatureRefused("unknown parameter: temperature")).toBe(true);
  });

  it("leaves a named value, a range error and other fields alone", () => {
    expect(parseTemperatureRefused(MOONSHOT_400)).toBe(false);
    expect(
      parseTemperatureRefused("temperature: Input should be less than or equal to 1"),
    ).toBe(false);
    expect(parseTemperatureRefused("top_k is deprecated for this model")).toBe(false);
    expect(parseTemperatureRefused("invalid max_tokens")).toBe(false);
  });
});

describe("temperatureLessonFromError", () => {
  const err = (status: number, body: string) =>
    new OpenAiHttpError(`openai provider ${status}: ${body}`, status, "u");

  it("names the one value, or says the field is refused, only on a 400", () => {
    expect(temperatureLessonFromError(err(400, MOONSHOT_400))).toEqual({
      kind: "fixed",
      value: 1,
    });
    expect(temperatureLessonFromError(err(400, ANTHROPIC_DEPRECATED_400))).toEqual({
      kind: "forbidden",
    });
    expect(temperatureLessonFromError(err(500, ANTHROPIC_DEPRECATED_400))).toBeUndefined();
    expect(temperatureLessonFromError(err(400, "invalid max_tokens"))).toBeUndefined();
    expect(temperatureLessonFromError("temperature is deprecated")).toBeUndefined();
  });
});
