import { afterEach, describe, expect, it } from "vitest";

import { buildOpenAiChatBody } from "./openai-build-body.js";
import {
  forgetLearnedModelParams,
  rememberAllowedTemperature,
  rememberTemperatureForbidden,
} from "./model-params.js";

afterEach(() => {
  forgetLearnedModelParams();
});

describe("buildOpenAiChatBody — temperature per model (ATO-1214)", () => {
  it.each(["kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"])(
    "sends temperature 1 for %s, whatever the caller asked",
    (model) => {
      expect(buildOpenAiChatBody({ prompt: "hi" }, model, false).temperature).toBe(1);
      expect(
        buildOpenAiChatBody({ prompt: "hi", temperature: 0 }, model, false).temperature,
      ).toBe(1);
    },
  );

  it.each(["kimi-k2.6", "moonshotai/kimi-k2.6", "gpt-4o"])(
    "keeps the historical 0.2 default for %s",
    (model) => {
      expect(buildOpenAiChatBody({ prompt: "hi" }, model, false).temperature).toBe(0.2);
    },
  );

  it("sends no temperature for gpt-5", () => {
    const body = buildOpenAiChatBody({ prompt: "hi", temperature: 0.7 }, "gpt-5", false);
    expect(body).not.toHaveProperty("temperature");
  });

  it("lets extraBody override a rule known up front", () => {
    const body = buildOpenAiChatBody({ prompt: "hi" }, "kimi-k3.1-pro", false, {
      temperature: 0.6,
    });
    expect(body.temperature).toBe(0.6);
  });

  it("puts a temperature the service named over extraBody and model params", () => {
    rememberAllowedTemperature("vendor/strict-model", 1);
    const body = buildOpenAiChatBody(
      { prompt: "hi", temperature: 0.3 },
      "vendor/strict-model",
      false,
      { temperature: 0.5 },
      undefined,
      undefined,
      undefined,
      { modelParams: { temperature: 0.4 } },
    );
    expect(body.temperature).toBe(1);
  });
});

describe("buildOpenAiChatBody — Claude models without temperature (ATO-1397)", () => {
  it.each(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"])(
    "sends no temperature for %s, whatever the caller asked, and keeps max_tokens",
    (model) => {
      const body = buildOpenAiChatBody(
        { prompt: "hi", temperature: 0.7, maxTokens: 512 },
        model,
        false,
      );
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_tokens).toBe(512);
    },
  );

  it("keeps the historical 0.2 default for claude-sonnet-4-6", () => {
    expect(
      buildOpenAiChatBody({ prompt: "hi" }, "claude-sonnet-4-6", false).temperature,
    ).toBe(0.2);
  });

  it("drops a temperature from extraBody and model params once the service refused it", () => {
    rememberTemperatureForbidden("vendor/strict-model");
    const body = buildOpenAiChatBody(
      { prompt: "hi", temperature: 0.3 },
      "vendor/strict-model",
      false,
      { temperature: 0.5 },
      undefined,
      undefined,
      undefined,
      { modelParams: { temperature: 0.4 } },
    );
    expect(body).not.toHaveProperty("temperature");
  });
});
