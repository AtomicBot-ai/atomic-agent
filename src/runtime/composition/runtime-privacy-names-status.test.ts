import { describe, expect, it } from "vitest";

import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import { privacyNamesStatus } from "./runtime-privacy-names-status.js";

function withNames(
  localNames: boolean,
  llm: AtomicAgentConfig["llm"],
  localModelsUrl = "http://127.0.0.1:9931",
): AtomicAgentConfig {
  const base = getConfig();
  return {
    ...base,
    localModels: { ...base.localModels, url: localModelsUrl },
    llm,
    privacy: { shield: { enabled: true, localNames } },
  } as AtomicAgentConfig;
}

const cloudOnly = {
  activeTextProvider: "cloud",
  activeEmbeddingProvider: "embed",
  providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.invalid/v1", model: "big" }],
  toolTransport: "auto",
} as unknown as AtomicAgentConfig["llm"];

const withLocal = {
  activeTextProvider: "cloud",
  activeEmbeddingProvider: "embed",
  providers: [
    { id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.invalid/v1", model: "big" },
    { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "qwen3-4b" },
  ],
  toolTransport: "auto",
} as unknown as AtomicAgentConfig["llm"];

describe("privacyNamesStatus (ATO-2527)", () => {
  it("is off when the switch is off, and still names the model it would use", () => {
    expect(privacyNamesStatus(withNames(false, withLocal))).toEqual({
      enabled: false,
      state: "off",
      model: { provider: "lmstudio", model: "qwen3-4b" },
    });
  });

  it("is ready with a model on this machine", () => {
    expect(privacyNamesStatus(withNames(true, withLocal))).toEqual({
      enabled: true,
      state: "ready",
      model: { provider: "lmstudio", model: "qwen3-4b" },
    });
  });

  it("says there is no local model when only cloud providers are set", () => {
    expect(privacyNamesStatus(withNames(true, cloudOnly))).toEqual({
      enabled: true,
      state: "no-local-model",
      model: null,
    });
  });

  it("does not count a llama-server on another computer", () => {
    expect(privacyNamesStatus(withNames(true, undefined, "http://192.168.1.20:9931")).state).toBe("no-local-model");
    expect(privacyNamesStatus(withNames(true, undefined)).state).toBe("ready");
  });
});
