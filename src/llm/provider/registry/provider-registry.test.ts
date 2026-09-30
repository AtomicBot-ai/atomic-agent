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
import { GeminiProvider } from "../gemini/gemini-provider.js";

describe("ProviderRegistry", () => {
  it("registers built-in kinds", () => {
    registerBuiltInProviderKinds();
    const kinds = knownProviderKinds();
    expect(kinds).toContain("llama-server");
    expect(kinds).toContain("openai-compatible");
    expect(kinds).toContain("qwen-openai-compatible");
    expect(kinds).toContain("openrouter");
    expect(kinds).toContain("gemini");
    expect(kinds).toContain("subscription-cli");
  });

  it("resolveLlmConfig synthesizes local-llama when llm block absent", () => {
    const cfg = getConfig();
    const resolved = resolveLlmConfig(cfg);
    expect(resolved.activeTextProvider).toBe("local-llama");
    expect(resolved.providers[0]?.kind).toBe("llama-server");
    expect(resolved.toolTransport).toBe("auto");
  });

  it("constructs Gemini through the built-in registry factory", async () => {
    const fakeConfig = {
      ...getConfig(),
      llm: {
        activeTextProvider: "gemini",
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [
          {
            id: "gemini",
            kind: "gemini",
            apiKey: "test-key",
          },
        ],
      },
    } as AtomicAgentConfig;

    const registry = await ProviderRegistry.fromConfig(fakeConfig, {
      config: fakeConfig,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
    });

    expect(registry.activeText).toBeInstanceOf(GeminiProvider);
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
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as never,
      }),
    ).rejects.toThrow(/unknown llm provider kind/);
  });
});

describe("ProviderRegistry with an incomplete provider entry", () => {
  const silent = () => {
    const warnings: Array<{ msg: string; fields: unknown }> = [];
    return {
      warnings,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg: string, fields?: unknown) => {
          warnings.push({ msg, fields });
        },
        error: () => {},
      } as never,
    };
  };
  const configWith = (activeTextProvider: string) =>
    ({
      ...getConfig(),
      llm: {
        activeTextProvider,
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [
          { id: "gemini", kind: "gemini", apiKey: "test-key" },
          // What an abandoned "add provider" wizard leaves behind: a
          // base URL, no model.
          {
            id: "ollama",
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        ],
      },
    }) as AtomicAgentConfig;

  it("skips and warns when the broken entry is not active", async () => {
    const cfg = configWith("gemini");
    const { logger, warnings } = silent();
    const registry = await ProviderRegistry.fromConfig(cfg, {
      config: cfg,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger,
    });
    expect(registry.activeText).toBeInstanceOf(GeminiProvider);
    expect(registry.listIds()).toEqual(["gemini"]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("ollama");
    await expect(registry.swapActive("ollama")).rejects.toThrow(
      /not configured/,
    );
  });

  it("still throws when the broken entry is the active provider", async () => {
    const cfg = configWith("ollama");
    const { logger } = silent();
    await expect(
      ProviderRegistry.fromConfig(cfg, {
        config: cfg,
        llamaClient: {} as never,
        getProfile: () => ({}) as never,
        logger,
      }),
    ).rejects.toThrow(/requires baseUrl and defaultChatModel/);
  });

  it("skips the broken entry on a hot merge too", async () => {
    const base = {
      ...getConfig(),
      llm: {
        activeTextProvider: "gemini",
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [{ id: "gemini", kind: "gemini", apiKey: "test-key" }],
      },
    } as AtomicAgentConfig;
    const { logger, warnings } = silent();
    const registry = await ProviderRegistry.fromConfig(base, {
      config: base,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger,
    });
    const cfg = configWith("gemini");
    const added = await registry.mergeProvidersFromConfig(cfg, {
      config: cfg,
      logger,
    });
    expect(added).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
