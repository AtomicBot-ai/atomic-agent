import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";
import { resolveModelPricingFor } from "../../../runtime/resolve-model-pricing.js";
import { estimateUsageCostUsd } from "../usage-cost.js";
import { ProviderRegistry, resolveLlmConfig } from "./provider-registry.js";
import { registerBuiltInProviderKinds } from "./register-built-in-providers.js";
import type { LlmProviderConfigEntry } from "./provider-types.js";

/**
 * ATO-1559: a turn's model reaches the wire. A per-turn model runs on a
 * copy of the provider built for that model (`modelVariant`, ATO-1148),
 * so these go through the real factories: the request body names the
 * turn's model, the result reports it, and its spend is priced as that
 * model. Without a per-turn model the entry's own model serves, as before.
 */
const USAGE = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 };

function captureFetch(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      // No `model` in the reply: the result's modelId then falls back to
      // the model the provider asked for.
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return { bodies };
}

async function registryWith(entry: LlmProviderConfigEntry) {
  registerBuiltInProviderKinds();
  const config = {
    ...getConfig(),
    llm: {
      activeTextProvider: entry.id,
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto" as const,
      providers: [entry],
    },
  } as AtomicAgentConfig;
  const registry = await ProviderRegistry.fromConfig(config, {
    config,
    llamaClient: {} as never,
    getProfile: () => ({}) as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
  return { registry, config };
}

const pricedModels = [
  { id: "model-a", kind: "chat" as const, pricing: { input: 1, output: 2 } },
  { id: "model-b", kind: "chat" as const, pricing: { input: 10, output: 20 } },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a per-turn model on the wire (ATO-1559)", () => {
  it("openai-compatible: the turn's model goes in the body and the result, the entry's model without one", async () => {
    const { bodies } = captureFetch();
    const { registry } = await registryWith({
      id: "cloud",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.invalid/v1",
      apiKey: "k",
      defaultChatModel: "model-a",
      userModels: pricedModels,
    } as LlmProviderConfigEntry);

    const turn = await registry.modelVariant("cloud", "model-b");
    const onTurnModel = await turn!.complete({ prompt: "hi" });
    const onDefault = await registry.getProvider("cloud")!.complete({ prompt: "hi" });

    expect(bodies[0]?.model).toBe("model-b");
    expect(onTurnModel.modelId).toBe("model-b");
    expect(bodies[1]?.model).toBe("model-a");
    expect(onDefault.modelId).toBe("model-a");
  });

  it("gemini: the turn's model goes in the body, the entry's model without one", async () => {
    const { bodies } = captureFetch();
    const { registry } = await registryWith({
      id: "gemini",
      kind: "gemini",
      apiKey: "k",
      defaultChatModel: "gemini-2.5-flash",
    } as LlmProviderConfigEntry);

    const turn = await registry.modelVariant("gemini", "gemini-2.5-pro");
    const onTurnModel = await turn!.complete({ prompt: "hi" });
    await registry.getProvider("gemini")!.complete({ prompt: "hi" });

    expect(bodies[0]?.model).toBe("gemini-2.5-pro");
    expect(onTurnModel.modelId).toBe("gemini-2.5-pro");
    expect(bodies[1]?.model).toBe("gemini-2.5-flash");
  });

  it("prices the turn's spend as the turn's model, not the entry's", async () => {
    captureFetch();
    const { registry, config } = await registryWith({
      id: "cloud",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.invalid/v1",
      apiKey: "k",
      defaultChatModel: "model-a",
      userModels: pricedModels,
    } as LlmProviderConfigEntry);

    const result = await (await registry.modelVariant("cloud", "model-b"))!.complete({ prompt: "hi" });
    // The runtime prices a completion by the model it reports and the
    // provider that served it (`recordUnaryUsage` in runtime-inference).
    const pricing = resolveModelPricingFor(resolveLlmConfig(config), result.modelId, "cloud")?.pricing;

    expect(pricing).toEqual({ input: 10, output: 20 });
    expect(estimateUsageCostUsd(result.usage!, pricing!)).toBe(30);
  });
});
