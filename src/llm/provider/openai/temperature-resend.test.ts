import { afterEach, describe, expect, it } from "vitest";

import { temperatureLessonFromResponse } from "./allowed-temperature.js";
import { forgetLearnedModelParams, modelParamProfile } from "./model-params.js";
import { bodyAfterTemperatureLesson } from "./temperature-resend.js";

/** #1554: side calls resend once after a 400 that taught the temperature. */

afterEach(() => {
  forgetLearnedModelParams();
});

const DEPRECATED =
  '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}';

describe("temperatureLessonFromResponse", () => {
  it("reads Anthropic's deprecated-temperature 400 as forbidden", () => {
    expect(temperatureLessonFromResponse(400, DEPRECATED)).toEqual({ kind: "forbidden" });
  });

  it("reads the one allowed value", () => {
    expect(
      temperatureLessonFromResponse(400, "invalid temperature: only 1 is allowed for this model"),
    ).toEqual({ kind: "fixed", value: 1 });
  });

  it("ignores the same words on any status but 400", () => {
    expect(temperatureLessonFromResponse(422, DEPRECATED)).toBeUndefined();
    expect(temperatureLessonFromResponse(undefined, DEPRECATED)).toBeUndefined();
  });

  it("ignores a 400 about something else", () => {
    expect(temperatureLessonFromResponse(400, "`top_k` is deprecated for this model")).toBeUndefined();
  });
});

describe("bodyAfterTemperatureLesson", () => {
  it("drops a refused temperature and remembers it for the model", () => {
    const model = "gateway/my-claude-alias";
    const sent = { model, temperature: 0, max_tokens: 1 };
    const resend = bodyAfterTemperatureLesson(model, { kind: "forbidden" }, sent);

    expect(resend).toEqual({ model, max_tokens: 1 });
    expect(sent).toHaveProperty("temperature", 0);
    expect(modelParamProfile(model).temperature).toEqual({ kind: "forbidden", learned: true });
  });

  it("does not resend a body that already had no temperature", () => {
    expect(
      bodyAfterTemperatureLesson("m", { kind: "forbidden" }, { model: "m" }),
    ).toBeUndefined();
  });

  it("puts the one allowed value on the resend", () => {
    const resend = bodyAfterTemperatureLesson(
      "vendor/strict",
      { kind: "fixed", value: 1 },
      { model: "vendor/strict", temperature: 0 },
    );
    expect(resend?.temperature).toBe(1);
    expect(modelParamProfile("vendor/strict").temperature).toEqual({
      kind: "fixed",
      value: 1,
      learned: true,
    });
  });

  it("does not resend when the body already carried that value", () => {
    expect(
      bodyAfterTemperatureLesson("m", { kind: "fixed", value: 1 }, { model: "m", temperature: 1 }),
    ).toBeUndefined();
  });

  it("does nothing without a lesson", () => {
    expect(bodyAfterTemperatureLesson("m", undefined, { temperature: 0 })).toBeUndefined();
  });
});
