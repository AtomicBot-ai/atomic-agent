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

  it("stamps the served transport on EVERY chunk (live consumers cannot wait for the final result)", async () => {
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
    const gen = streamer(baseParams);
    const chunks: StreamChunk[] = [];
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    expect(chunks.length).toBeGreaterThan(0);
    // The load-bearing assertion: the step executor's stream parser keys
    // `preOpenedThink` off the serving link's transport, which it must
    // learn from the FIRST chunk — the return-value stamp arrives after
    // the last delta, too late to classify reasoning live.
    for (const chunk of chunks) {
      expect(chunk.servedTransport).toBe("grammar");
    }
  });
});

describe("per-link prompt substitution (grammarPrompt)", () => {
  async function drain(
    gen: AsyncGenerator<StreamChunk, CompletionResult, void>,
  ): Promise<CompletionResult> {
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  function promptCapturingProviders(): {
    providers: Map<string, LlmProvider>;
    cloudPrompts: string[];
    localPrompts: string[];
    failCloud: () => void;
  } {
    const cloudPrompts: string[] = [];
    const localPrompts: string[] = [];
    let cloudFails = false;
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async (request) => {
          cloudPrompts.push(request.prompt);
          if (cloudFails) {
            throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
          }
          return answer("cloud");
        }),
      ],
      [
        "local",
        fakeProvider("local", "grammar", async (request) => {
          localPrompts.push(request.prompt);
          return answer("local");
        }),
      ],
    ]);
    return {
      providers,
      cloudPrompts,
      localPrompts,
      failCloud: () => {
        cloudFails = true;
      },
    };
  }

  const paramsWithVariant = {
    ...baseParams,
    prompt: "suppressed prompt",
    grammarPrompt: () => "prefill-carrying prompt",
  };

  it("unary: the native primary gets `prompt`, a grammar fallover link gets the `grammarPrompt` variant", async () => {
    const { providers, cloudPrompts, localPrompts, failCloud } =
      promptCapturingProviders();
    const complete = createFallbackCompleter(seamDeps(providers));

    await complete(paramsWithVariant);
    expect(cloudPrompts).toEqual(["suppressed prompt"]);
    expect(localPrompts).toEqual([]);

    failCloud();
    const result = await complete(paramsWithVariant);
    expect(result.modelId).toBe("local-model");
    expect(localPrompts).toEqual(["prefill-carrying prompt"]);
  });

  it("streaming: a grammar fallover link gets the `grammarPrompt` variant", async () => {
    const { providers, localPrompts, failCloud } = promptCapturingProviders();
    failCloud();
    const streamer = createFallbackStreamer(seamDeps(providers));
    const result = await drain(streamer(paramsWithVariant));
    expect(result.servedTransport).toBe("grammar");
    expect(localPrompts).toEqual(["prefill-carrying prompt"]);
  });

  it("absent variant: a grammar link falls back to the shared prompt", async () => {
    const { providers, localPrompts, failCloud } = promptCapturingProviders();
    failCloud();
    const complete = createFallbackCompleter(seamDeps(providers));
    const result = await complete({ ...baseParams, prompt: "shared prompt" });
    expect(result.modelId).toBe("local-model");
    expect(localPrompts).toEqual(["shared prompt"]);
  });
});

/**
 * Issue #112. Boot skips the local `/health` + `/props` probes while a
 * cloud provider is active, which leaves a `llama-server` link running
 * on a deferred profile, a one-slot pool and no health reading. A
 * cloud→local FALLOVER reaches that link without any config change and
 * without the agent loop's turn-start refresh (it saw a cloud route when
 * the turn began), so the seam is the last point at which the state can
 * still be warmed. These tests pin the ordering: `prepareLink` for the
 * link that is about to serve, before its completion is sent.
 */
describe("prepareLink — warming a link before it serves (issue #112)", () => {
  function tracingDeps(
    providers: Map<string, LlmProvider>,
    trace: string[],
  ): FallbackSeamDeps {
    const deps = seamDeps(providers);
    deps.prepareLink = async (providerId) => {
      trace.push(`prepare:${providerId}`);
    };
    return deps;
  }

  it("prepares the local link before the fallover attempt is sent", async () => {
    const trace: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          trace.push("serve:cloud");
          throw new OpenAiHttpError(
            "rate limited",
            429,
            "http://cloud",
            false,
            null,
            "cloud",
          );
        }),
      ],
      [
        "local",
        fakeProvider("local", "grammar", async () => {
          trace.push("serve:local");
          return answer("local");
        }),
      ],
    ]);
    const result = await createFallbackCompleter(
      tracingDeps(providers, trace),
    )(baseParams);

    expect(result.modelId).toBe("local-model");
    // The load-bearing ordering: `prepare:local` sits BEFORE
    // `serve:local`. Without the hook the local link would answer with
    // its profile, grammar and slot pool never probed.
    expect(trace).toEqual([
      "prepare:cloud",
      "serve:cloud",
      "prepare:local",
      "serve:local",
    ]);
  });

  it("streaming: prepares the local link before the stream is opened", async () => {
    const trace: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          trace.push("serve:cloud");
          throw new OpenAiHttpError(
            "rate limited",
            429,
            "http://cloud",
            false,
            null,
            "cloud",
          );
        }),
      ],
      [
        "local",
        fakeProvider("local", "grammar", async () => {
          trace.push("serve:local");
          return answer("local");
        }),
      ],
    ]);
    const streamer = createFallbackStreamer(tracingDeps(providers, trace));
    const gen = streamer(baseParams);
    let next = await gen.next();
    while (!next.done) next = await gen.next();

    expect(next.value.servedTransport).toBe("grammar");
    expect(trace).toEqual([
      "prepare:cloud",
      "serve:cloud",
      "prepare:local",
      "serve:local",
    ]);
  });

  it("is optional — an unwired seam behaves exactly as before", async () => {
    const providers = new Map<string, LlmProvider>([
      ["cloud", fakeProvider("cloud", "native_tools", async () => answer("cloud"))],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const result = await createFallbackCompleter(seamDeps(providers))(baseParams);
    expect(result.modelId).toBe("cloud-model");
  });
});
