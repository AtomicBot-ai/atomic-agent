import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLlmProviderApiKey } from "./resolve-llm-api-key.js";

describe("resolveLlmProviderApiKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves Ollama keys from OLLAMA_API_KEY, staying keyless when unset", () => {
    expect(
      resolveLlmProviderApiKey({ id: "ollama", kind: "ollama" }),
    ).toBeUndefined();
    vi.stubEnv("OLLAMA_API_KEY", "ollama-test-key");
    expect(resolveLlmProviderApiKey({ id: "ollama", kind: "ollama" })).toBe(
      "ollama-test-key",
    );
  });

  it("resolves Gemini keys from GEMINI_API_KEY", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");

    expect(resolveLlmProviderApiKey({ id: "gemini", kind: "gemini" })).toBe(
      "gemini-test-key",
    );
  });
});
