import { afterEach, describe, expect, it } from "vitest";

import {
  defaultReasoningEffort,
  forgetLearnedModelParams,
  modelParamProfile,
  rememberAllowedTemperature,
  rememberTemperatureForbidden,
  resolveTemperature,
} from "./model-params.js";

afterEach(() => {
  forgetLearnedModelParams();
});

describe("modelParamProfile", () => {
  it.each(["o3", "o4-mini", "gpt-5", "openai/gpt-5-codex", "gpt-6", "gpt-6.1-sol", "gpt-6.2-sol", "openai/gpt-6-terra", "GPT-6-Astra"])(
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
    "gpt-4.1-mini",
    "gpt-35-turbo",
    "gpt-35-turbo-16k",
    "gpt-35-turbo-instruct",
    "olmo-3",
  ])("leaves temperature free for %s", (model) => {
    expect(modelParamProfile(model)).toEqual({
      temperature: { kind: "free" },
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

describe("modelParamProfile — Claude models without sampling parameters (ATO-1397)", () => {
  it.each([
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-5-fast",
    "anthropic/claude-sonnet-5.5",
    "anthropic.claude-haiku-5-5",
    "us.anthropic.claude-opus-5-5",
    "claude-sonnet-5-20260101",
    "Claude-Sonnet-5-5",
    // An unknown future version falls on the side of the line that omits.
    "claude-sonnet-6",
  ])("forbids temperature but keeps max_tokens for %s", (model) => {
    expect(modelParamProfile(model)).toEqual({
      temperature: { kind: "forbidden" },
      capField: "max_tokens",
    });
  });

  it.each([
    "claude-opus-4-6",
    "claude-opus-4-1-20250805",
    "claude-opus-4",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "anthropic/claude-haiku-4.5",
    "claude-3-5-sonnet-20241022",
    // Names Claude but is not one: the rule is anchored at the id's start.
    "Qwen3-8B-Claude-Sonnet-5-Distill",
    "someorg/Qwen3-8B-Claude-Sonnet-5-Distill",
  ])("leaves temperature free for %s", (model) => {
    expect(modelParamProfile(model).temperature).toEqual({ kind: "free" });
  });

  it("learns at run time that a model takes no temperature, for that id only", () => {
    expect(rememberTemperatureForbidden("vendor/new-model")).toBe(true);
    expect(rememberTemperatureForbidden("vendor/new-model")).toBe(false);
    expect(modelParamProfile("vendor/new-model")).toEqual({
      temperature: { kind: "forbidden", learned: true },
      capField: "max_tokens",
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
    expect(
      resolveTemperature(modelParamProfile("claude-sonnet-5-5"), 0.7, 0.2),
    ).toBeUndefined();
  });

  it("sends the one allowed value when fixed, whatever was asked", () => {
    const profile = modelParamProfile("kimi-k3.1-pro");
    expect(resolveTemperature(profile, 0, 0.2)).toBe(1);
    expect(resolveTemperature(profile, undefined, 0.2)).toBe(1);
  });
});

describe("defaultReasoningEffort (ATO-1368)", () => {
  it.each(["anthropic/claude-fable-5.2", "claude-fable-5-2", "anthropic/claude-fable-5.3", "claude-fable-6"])(
    "runs %s at medium unless asked otherwise",
    (model) => {
      expect(defaultReasoningEffort(model)).toBe("medium");
    },
  );

  it.each(["anthropic/claude-fable-5", "anthropic/claude-fable-5.1", "anthropic/claude-opus-5.5", "openai/gpt-6.2-sol"])(
    "leaves the service default for %s",
    (model) => {
      expect(defaultReasoningEffort(model)).toBeUndefined();
    },
  );
});
