import { describe, expect, it } from "vitest";
import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";
import { ProviderRegistry, registerProviderKind } from "./provider-registry.js";
import type { LlmProviderConfigEntry } from "./provider-types.js";

/**
 * ATO-1148: a turn on a project's own cloud model runs on a copy of the
 * pinned provider built for that model. The copy must not move the
 * active provider or stand in for the configured one.
 */
const KIND = "test-model-variant-kind";

function fixture() {
  const built: Array<{ entry: LlmProviderConfigEntry; closed: boolean }> = [];
  registerProviderKind(KIND, ({ entry }) => {
    const record = { entry, closed: false };
    built.push(record);
    return {
      id: entry.id,
      name: entry.id,
      model: entry.defaultChatModel,
      close: async () => { record.closed = true; },
    } as never;
  });
  const config = {
    ...getConfig(),
    llm: {
      activeTextProvider: "cloud-a",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto" as const,
      providers: [
        { id: "cloud-a", kind: KIND, baseUrl: "https://a.example.invalid", defaultChatModel: "model-a", apiKey: "k-a" },
        { id: "cloud-b", kind: KIND, baseUrl: "https://b.example.invalid", defaultChatModel: "model-b", apiKey: "k-b" },
      ],
    },
  } as AtomicAgentConfig;
  const ctx = {
    config,
    llamaClient: {} as never,
    getProfile: () => ({}) as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  };
  return { built, config, ctx };
}

describe("ProviderRegistry.modelVariant (ATO-1148)", () => {
  it("builds the pinned provider again for another model and leaves the active provider alone", async () => {
    const { built, config, ctx } = fixture();
    const registry = await ProviderRegistry.fromConfig(config, ctx);
    const base = registry.getProvider("cloud-b");

    const variant = await registry.modelVariant("cloud-b", "model-b-large");

    expect(variant).toBeDefined();
    expect(variant).not.toBe(base);
    const entry = built.at(-1)?.entry;
    expect(entry).toMatchObject({ id: "cloud-b", baseUrl: "https://b.example.invalid", apiKey: "k-b", defaultChatModel: "model-b-large" });
    expect(registry.activeTextProviderId).toBe("cloud-a");
    expect(registry.getProvider("cloud-b")).toBe(base);
    expect(registry.listIds()).toEqual(["cloud-a", "cloud-b"]);
  });

  it("reuses one copy per provider and model, and the base for its own model", async () => {
    const { built, config, ctx } = fixture();
    const registry = await ProviderRegistry.fromConfig(config, ctx);
    const before = built.length;

    const first = await registry.modelVariant("cloud-b", "model-x");
    const again = await registry.modelVariant("cloud-b", "model-x");
    const own = await registry.modelVariant("cloud-b", "model-b");

    expect(again).toBe(first);
    expect(own).toBe(registry.getProvider("cloud-b"));
    expect(built.length).toBe(before + 1);
  });

  it("is undefined for a provider that is not configured", async () => {
    const { config, ctx } = fixture();
    const registry = await ProviderRegistry.fromConfig(config, ctx);
    await expect(registry.modelVariant("nope", "model-x")).resolves.toBeUndefined();
  });

  it("closes and forgets the copies when their provider is removed", async () => {
    const { built, config, ctx } = fixture();
    const registry = await ProviderRegistry.fromConfig(config, ctx);
    await registry.modelVariant("cloud-b", "model-x");
    const copy = built.at(-1);

    await registry.removeProvider("cloud-b");

    expect(copy?.closed).toBe(true);
    await expect(registry.modelVariant("cloud-b", "model-x")).resolves.toBeUndefined();
  });
});
