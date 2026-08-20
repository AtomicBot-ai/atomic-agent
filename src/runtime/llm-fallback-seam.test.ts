import { describe, expect, it } from "vitest";

import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import {
  createFallbackCompleter,
  createFallbackStreamer,
  type FallbackSeamDeps,
} from "./llm-fallback-seam.js";

/**
 * These tests drive the REAL bootstrap seam factories, not an inline copy
 * of their logic — so deleting the `servedTransport` stamp inside
 * `llm-fallback-seam.ts` turns them red (that stamping, `bootstrap.ts`
 * lines under `createFallbackCompleter` / `createFallbackStreamer`, was
 * previously only re-implemented in the e2e test and thus uncovered).
 */

function fakeProvider(
  id: string,
  transport: ToolCallTransport,
  serve: (request: CompletionRequest) => Promise<CompletionResult>,
): LlmProvider {
  return {
    id,
    name: id,
    capabilities: {
      vision: false,
      visionSource: "absent",
      toolTransport: transport,
      contextWindow: 128_000,
      supportsParallelTools: transport === "native_tools",
      supportsSlotAffinity: transport === "grammar",
      supportsPromptCache: false,
      reasoningFormat: "none",
    },
    toolCallAdapter: transport === "native_tools" ? openAiToolCallAdapter : null,
    streamConsumer: null,
    complete: serve,
    async *completeStream(request) {
      const result = await serve(request);
      yield { delta: result.content, reasoningDelta: "", done: true } as StreamChunk;
      return result;
    },
    async describeImage() {
      throw new Error("no vision");
    },
    async health() {
      return { reachable: true, status: 200, error: null, latencyMs: 1 };
    },
    async close() {},
  };
}

function answer(id: string): CompletionResult {
  return {
    content: "ok",
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: `${id}-model`,
  };
}

function seamDeps(providers: Map<string, LlmProvider>): FallbackSeamDeps {
  const chain = new ProviderFallbackChain({
    resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }),
  });
  return {
    fallbackChain: chain,
    resolveSlice: (providerId) => {
      const provider = providers.get(providerId)!;
      return { provider, transport: provider.capabilities.toolTransport };
    },
    recordUnaryUsage: () => {},
    recordStreamUsage: () => {},
  };
}

const baseParams = {
  prompt: "hi",
  grammar: 'root ::= "ok"',
  slotId: 0,
  sessionId: "s1",
  tools: [],
} as const;

describe("createFallbackCompleter (real bootstrap seam)", () => {
  it("stamps servedTransport with the primary's transport when it answers", async () => {
    const providers = new Map<string, LlmProvider>([
      ["cloud", fakeProvider("cloud", "native_tools", async () => answer("cloud"))],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const complete = createFallbackCompleter(seamDeps(providers));
    const result = await complete(baseParams);
    expect(result.servedTransport).toBe("native_tools");
    expect(result.modelId).toBe("cloud-model");
  });

  it("stamps the SERVED link's transport (grammar) after a 429 fallover, not the primary's", async () => {
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
        }),
      ],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const complete = createFallbackCompleter(seamDeps(providers));
    const result = await complete(baseParams);
    // The load-bearing assertion: without the stamp this would be
    // undefined (or the primary's native transport); the served link is
    // grammar.
    expect(result.servedTransport).toBe("grammar");
    expect(result.servedTransport).not.toBe("native_tools");
    expect(result.modelId).toBe("local-model");
  });

  it("folds usage through the injected recorder", async () => {
    const recorded: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => ({
          ...answer("cloud"),
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })),
      ],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const deps = seamDeps(providers);
    deps.recordUnaryUsage = (_p, r) => recorded.push(r.modelId);
    const complete = createFallbackCompleter(deps);
    await complete(baseParams);
    expect(recorded).toEqual(["cloud-model"]);
  });
});

describe("createFallbackStreamer (real bootstrap seam)", () => {
  async function drain(
    gen: AsyncGenerator<StreamChunk, CompletionResult, void>,
  ): Promise<CompletionResult> {
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  it("stamps the served link's transport on the streamed result after a fallover", async () => {
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
        }),
      ],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const streamer = createFallbackStreamer(seamDeps(providers));
    const result = await drain(streamer(baseParams));
    expect(result.servedTransport).toBe("grammar");
    expect(result.servedTransport).not.toBe("native_tools");
  });

  it("stamps the primary's transport when the stream opens on the primary", async () => {
    const providers = new Map<string, LlmProvider>([
      ["cloud", fakeProvider("cloud", "native_tools", async () => answer("cloud"))],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const streamer = createFallbackStreamer(seamDeps(providers));
    const result = await drain(streamer(baseParams));
    expect(result.servedTransport).toBe("native_tools");
  });
});

describe("fusion routing through the real seam", () => {
  const providers = () =>
    new Map<string, LlmProvider>([
      ["cloud", fakeProvider("cloud", "native_tools", async () => answer("cloud"))],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);

  it("stamps servedProviderId with the link that answered", async () => {
    const complete = createFallbackCompleter(seamDeps(providers()));
    const result = await complete(baseParams);
    expect(result.servedProviderId).toBe("cloud");
  });

  it("starts at preferredProviderId instead of the chain primary", async () => {
    const complete = createFallbackCompleter(seamDeps(providers()));
    const result = await complete({
      ...baseParams,
      preferredProviderId: "local",
    });
    // Load-bearing: "local" is the chain TAIL, so without the
    // preference plumbing this would answer from "cloud".
    expect(result.servedProviderId).toBe("local");
    expect(result.modelId).toBe("local-model");
    // And the transport stamp must follow the routed leg, not the primary.
    expect(result.servedTransport).toBe("grammar");
  });

  it("still falls over on health when the preferred leg fails", async () => {
    const map = new Map<string, LlmProvider>([
      ["cloud", fakeProvider("cloud", "native_tools", async () => answer("cloud"))],
      [
        "local",
        fakeProvider("local", "grammar", async () => {
          throw new OpenAiHttpError("boom", 503, "http://local", false, null, "local");
        }),
      ],
    ]);
    const complete = createFallbackCompleter(seamDeps(map));
    const result = await complete({
      ...baseParams,
      preferredProviderId: "local",
    });
    expect(result.servedProviderId).toBe("cloud");
  });

  it("prices against the served leg, not the active one", async () => {
    // Guards the fusion cost-attribution fix in bootstrap: the recorder
    // is handed the id of the link that answered.
    const seen: string[] = [];
    const deps = seamDeps(providers());
    const complete = createFallbackCompleter({
      ...deps,
      recordUnaryUsage: (_params, _result, servedProviderId) => {
        seen.push(servedProviderId);
      },
    });
    await complete({ ...baseParams, preferredProviderId: "local" });
    expect(seen).toEqual(["local"]);
  });

  it("routes the stream seam by preference and stamps the served id", async () => {
    const stream = createFallbackStreamer(seamDeps(providers()));
    const gen = stream({ ...baseParams, preferredProviderId: "local" });
    let next = await gen.next();
    while (next.done !== true) next = await gen.next();
    expect(next.value.servedProviderId).toBe("local");
    expect(next.value.servedTransport).toBe("grammar");
  });
});
