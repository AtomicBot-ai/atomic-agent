import { afterEach, describe, expect, it } from "vitest";

import {
  forgetLearnedModelParams,
  modelParamProfile,
  rememberAllowedTemperature,
  resolveTemperature,
} from "./model-params.js";

afterEach(() => {
  forgetLearnedModelParams();
});

describe("modelParamProfile", () => {
  it.each(["o3", "o4-mini", "gpt-5", "openai/gpt-5-codex"])(
    "forbids temperature and caps with max_completion_tokens for %s",
    (model) => {
      expect(modelParamProfile(model)).toEqual({
        temperature: { kind: "forbidden" },
        capField: "max_completion_tokens",
      });
    },
  );

  // Moonshot answers anything but 1 with "only 1 is allowed for this
  // model" on the K3.1 family (ATO-1214).
  it.each([
    "kimi-k3.1",
    "kimi-k3.1-pro",
    "kimi-k3.1-pro-highspeed",
    "moonshotai/kimi-k3.1-pro",
    "Kimi-K3.1-Pro",
  ])("fixes temperature at 1 for %s", (model) => {
    expect(modelParamProfile(model)).toEqual({
      temperature: { kind: "fixed", value: 1 },
      capField: "max_tokens",
    });
  });

  it.each([
    "kimi-k2.6",
    "moonshotai/kimi-k2.5",
    // Unverified, so left free on purpose; see the comment on the rule.
    "kimi-k3",
    "kimi-k3-preview",
    "kimi-k3.10",
    "gpt-4o",
    "olmo-3",
  ])("leaves temperature free for %s", (model) => {
    expect(modelParamProfile(model)).toEqual({
      temperature: { kind: "free" },
      capField: "max_tokens",
    });
  });

  // Anthropic answers any temperature on Claude 5.x with "`temperature`
  // is deprecated for this model" (ATO-1397).
  it.each([
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "anthropic/claude-sonnet-5.5",
  ])("sends no temperature to %s", (model) => {
    expect(modelParamProfile(model)).toEqual({
      temperature: { kind: "forbidden" },
      capField: "max_tokens",
    });
  });

  it.each(["claude-sonnet-4-5", "anthropic/claude-3.7-sonnet", "claude-opus-4-1"])(
    "leaves temperature free for older Claude %s",
    (model) => {
      expect(modelParamProfile(model).temperature).toEqual({ kind: "free" });
    },
  );

  it("forbids temperature once a service said the model takes none", () => {
    expect(rememberAllowedTemperature("vendor/no-temp", "omit")).toBe(true);
    expect(rememberAllowedTemperature("vendor/no-temp", "omit")).toBe(false);
    expect(modelParamProfile("vendor/no-temp")).toEqual({
      temperature: { kind: "forbidden", learned: true },
      capField: "max_tokens",
    });
  });

  it("uses a temperature learned at run time, for that model id only", () => {
    expect(rememberAllowedTemperature("vendor/new-model", 0.6)).toBe(true);
    expect(rememberAllowedTemperature("vendor/new-model", 0.6)).toBe(false);
    expect(modelParamProfile("vendor/new-model").temperature).toEqual({
      kind: "fixed",
      value: 0.6,
      learned: true,
    });
    expect(modelParamProfile("vendor/other-model").temperature).toEqual({
      kind: "free",
    });
  });
});

describe("resolveTemperature", () => {
  it("sends the caller's value, else the fallback, when free", () => {
    const profile = modelParamProfile("gpt-4o");
    expect(resolveTemperature(profile, 0.7, 0.2)).toBe(0.7);
    expect(resolveTemperature(profile, undefined, 0.2)).toBe(0.2);
    expect(resolveTemperature(profile, undefined, undefined)).toBeUndefined();
  });

  it("sends nothing when forbidden", () => {
    expect(resolveTemperature(modelParamProfile("gpt-5"), 0.7, 0.2)).toBeUndefined();
  });

  it("sends the one allowed value when fixed, whatever was asked", () => {
    const profile = modelParamProfile("kimi-k3.1-pro");
    expect(resolveTemperature(profile, 0, 0.2)).toBe(1);
    expect(resolveTemperature(profile, undefined, 0.2)).toBe(1);
  });
});
