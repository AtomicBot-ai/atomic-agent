import { describe, expect, it } from "vitest";

import {
  allowedTemperatureFromError,
  parseAllowedTemperature,
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
