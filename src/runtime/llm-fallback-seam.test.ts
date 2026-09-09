import { describe, expect, it, vi } from "vitest";

import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import {
  fakeAnswer as answer,
  fakeProvider,
} from "../llm/provider/fake-provider.fixture.js";
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

/**
 * A pinned request (`params.providerId`) is a fusion worker spending
 * local tokens on purpose. It must reach exactly that provider — never
 * the chain's pick, never a fallover — and a failure is the
 * orchestrator's to handle, not the breaker's.
 */
describe("providerId pin — bypasses the chain", () => {
  async function drain(
    gen: AsyncGenerator<StreamChunk, CompletionResult, void>,
  ): Promise<CompletionResult> {
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  function pinnedFixture() {
    const served: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          served.push("cloud");
          return answer("cloud");
        }),
      ],
      [
        "local",
        fakeProvider("local", "grammar", async () => {
          served.push("local");
          return answer("local");
        }),
      ],
    ]);
    const deps = seamDeps(providers);
    const pick = vi.spyOn(deps.fallbackChain, "pickProvider");
    const prepared: string[] = [];
    deps.prepareLink = async (id) => {
      prepared.push(id);
    };
    return { deps, served, pick, prepared };
  }

  it("unary: serves the pinned link without consulting the chain, still warming it", async () => {
    const { deps, served, pick, prepared } = pinnedFixture();
    const usage: string[] = [];
    deps.recordUnaryUsage = (_p, _r, providerId) => usage.push(providerId);
    const result = await createFallbackCompleter(deps)({
      ...baseParams,
      providerId: "local",
    });
    // The chain's primary is "cloud"; the pin wins and the chain is never
    // even asked.
    expect(result.modelId).toBe("local-model");
    expect(result.servedTransport).toBe("grammar");
    expect(served).toEqual(["local"]);
    expect(pick).not.toHaveBeenCalled();
    expect(prepared).toEqual(["local"]);
    expect(usage).toEqual(["local"]);
  });

  it("streaming: opens the stream on the pinned link, chain untouched, usage attributed to it", async () => {
    const { deps, served, pick, prepared } = pinnedFixture();
    const usage: string[] = [];
    deps.recordStreamUsage = (_s, _r, providerId) => usage.push(providerId);
    const result = await drain(
      createFallbackStreamer(deps)({ ...baseParams, providerId: "local" }),
    );
    expect(result.modelId).toBe("local-model");
    expect(result.servedTransport).toBe("grammar");
    expect(served).toEqual(["local"]);
    expect(pick).not.toHaveBeenCalled();
    expect(prepared).toEqual(["local"]);
    expect(usage).toEqual(["local"]);
  });

  it("a pinned failure is rethrown as-is and never falls over", async () => {
    const served: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          served.push("cloud");
          return answer("cloud");
        }),
      ],
      [
        "local",
        fakeProvider("local", "grammar", async () => {
          served.push("local");
          throw new OpenAiHttpError("down", 503, "http://local", false, null, "local");
        }),
      ],
    ]);
    const deps = seamDeps(providers);
    const pick = vi.spyOn(deps.fallbackChain, "pickProvider");
    const advance = vi.spyOn(deps.fallbackChain, "advanceFrom");
    await expect(
      createFallbackCompleter(deps)({ ...baseParams, providerId: "local" }),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    await expect(
      drain(createFallbackStreamer(deps)({ ...baseParams, providerId: "local" })),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    // A 503 would have switched the chain on the first failure. The
    // healthy cloud link was never tried, and the breaker never moved.
    expect(served).toEqual(["local", "local"]);
    expect(pick).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("the chain-picked path reports the SERVED link's id to the usage recorders", async () => {
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
          throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
        }),
      ],
      ["local", fakeProvider("local", "grammar", async () => answer("local"))],
    ]);
    const deps = seamDeps(providers);
    const unary: string[] = [];
    const stream: string[] = [];
    deps.recordUnaryUsage = (_p, _r, providerId) => unary.push(providerId);
    deps.recordStreamUsage = (_s, _r, providerId) => stream.push(providerId);
    await createFallbackCompleter(deps)(baseParams);
    await drain(createFallbackStreamer(deps)(baseParams));
    // Not "cloud" — the active/primary id — but the link that answered.
    expect(unary).toEqual(["local"]);
    expect(stream).toEqual(["local"]);
  });
});
