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

describe("ProviderRegistry pinned providers", () => {
  /** Minimal stand-in that records whether it was torn down. */
  function fake(id: string) {
    const state = { closed: false };
    const provider = {
      id,
      name: id,
      capabilities: {},
      toolCallAdapter: null,
      streamConsumer: null,
      async complete() {
        throw new Error("unused");
      },
      async *completeStream() {
        throw new Error("unused");
      },
      async describeImage() {
        throw new Error("unused");
      },
      async health() {
        return { reachable: true, status: 200, error: null, latencyMs: 1 };
      },
      async close() {
        state.closed = true;
      },
    };
    return { provider, state };
  }

  function registryOf(ids: string[]) {
    const fakes = ids.map((id) => fake(id));
    const map = new Map(
      fakes.map((f) => [f.provider.id, f.provider as never] as const),
    );
    // `new ProviderRegistry(...)` is private to the module's factory, so
    // reach it the same way `fromConfig` does.
    const registry = Reflect.construct(ProviderRegistry, [ids[0], map]) as
      ProviderRegistry;
    return { registry, fakes };
  }

  it("closes the previous provider on a plain swap", async () => {
    const { registry, fakes } = registryOf(["cloud", "local"]);
    await registry.swapActive("local");
    expect(fakes[0]!.state.closed).toBe(true);
  });

  it("keeps a pinned provider open across a swap", async () => {
    // Fusion keeps both legs live; closing the one it is about to route
    // to would break the executor leg on the very next step.
    const { registry, fakes } = registryOf(["cloud", "local"]);
    registry.setPinnedProviderIds(() => new Set(["cloud", "local"]));
    await registry.swapActive("local");
    expect(fakes[0]!.state.closed).toBe(false);
    expect(registry.activeText.id).toBe("local");
  });

  it("resumes closing once nothing is pinned", async () => {
    const { registry, fakes } = registryOf(["cloud", "local"]);
    registry.setPinnedProviderIds(() => new Set<string>());
    await registry.swapActive("local");
    expect(fakes[0]!.state.closed).toBe(true);
  });
});
