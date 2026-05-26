import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  registerProviderKind,
  resolveLlmConfig,
  knownProviderKinds,
} from "./provider-registry.js";
import { registerBuiltInProviderKinds } from "./register-built-in-providers.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";

describe("ProviderRegistry", () => {
  it("registers built-in kinds", () => {
    registerBuiltInProviderKinds();
    const kinds = knownProviderKinds();
    expect(kinds).toContain("llama-server");
    expect(kinds).toContain("openai-compatible");
    expect(kinds).toContain("openrouter");
  });

  it("resolveLlmConfig synthesizes local-llama when llm block absent", () => {
    const cfg = getConfig();
    const resolved = resolveLlmConfig(cfg);
    expect(resolved.activeTextProvider).toBe("local-llama");
    expect(resolved.providers[0]?.kind).toBe("llama-server");
    expect(resolved.toolTransport).toBe("auto");
  });

  it("rejects unknown provider kind at fromConfig", async () => {
    registerBuiltInProviderKinds();
    const fakeConfig = {
      ...getConfig(),
      llm: {
        activeTextProvider: "bad",
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [{ id: "bad", kind: "nonexistent-kind" }],
      },
    } as AtomicAgentConfig;
    await expect(
      ProviderRegistry.fromConfig(fakeConfig, {
        config: fakeConfig,
        llamaClient: {} as never,
        getProfile: () => ({}) as never,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/unknown llm provider kind/);
  });
});
