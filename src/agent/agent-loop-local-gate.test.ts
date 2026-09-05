import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type {
  CompletionResult,
  LlamaServerClient,
} from "../llm/llama-server-client.js";
import { ModelProfileManager } from "../llm/model-profile-manager.js";
import { GEMMA4_PROPS, QWEN3_PROPS } from "../llm/model-profile.fixtures.js";
import { QWEN_THINK_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import {
  createLocalLinkPreparer,
  DeferredLocalBackendProbes,
} from "../llm/local-backend-gate.js";
import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import { providerIdIsLlamaServer } from "../llm/provider/registry/active-text-provider.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-registry.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { StreamChunk } from "../llm/provider/completion-types.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import { createFallbackCompleter } from "../runtime/llm-fallback-seam.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * Issue #112 — the loop's two `ModelProfileManager` probes are
 * llama-server traffic, and a cloud turn must produce none of it.
 *
 * `fetchProps` is the counted local request: it IS the `/props` call,
 * one layer below the HTTP client. Counts are exact — the pre-fix
 * behaviour was one probe per turn plus one per stale step, so a
 * `not.toHaveBeenCalled()` would not catch a regression that merely
 * moved the probe.
 */

function makeCompletion(
  content: string,
  modelId: string = "mock",
): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId,
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

describe("AgentLoop — local profile probes are gated on the active route", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-loop-gate-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const buildLoop = async (
    localBackend: ConstructorParameters<typeof AgentLoop>[0]["localBackend"],
  ) => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    const fetchProps = vi.fn<[], Promise<Record<string, unknown>>>();
    fetchProps.mockResolvedValue(GEMMA4_PROPS);
    const profileManager = new ModelProfileManager({
      llama: { fetchProps } as unknown as LlamaServerClient,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "qwen3-30b-a3b-instruct-2507",
    });
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar,
      profile: QWEN_THINK_PROFILE,
      profileManager,
      ...(localBackend ? { localBackend } : {}),
      // Pre-closed reasoning channel so the reply parses under either
      // profile — what is under test is the probe count, not parsing.
      // The completion echoes the model the manager already believes is
      // loaded, so nothing here marks it stale: staleness has its own
      // reactive-refresh tests, and letting it leak in would add probes
      // that the gate is not responsible for.
      llmComplete: async () =>
        makeCompletion(
          `</think><channel|>${JSON.stringify({
            tool: "finish",
            args: { summary: "done" },
          })}`,
          "qwen3-30b-a3b-instruct-2507",
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    return { loop, fetchProps, profileManager };
  };

  const runTurn = async (loop: AgentLoop, id: string) =>
    loop.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "go",
      maxSteps: 2,
      signal: new AbortController().signal,
    });

  it("makes zero /props requests on a cloud turn", async () => {
    const { loop, fetchProps, profileManager } = await buildLoop({
      isActive: () => false,
      ensureProbed: async () => false,
    });

    const result = await runTurn(loop, "s-cloud");

    expect(result.reason).toBe("finish");
    expect(fetchProps).toHaveBeenCalledTimes(0);
    // ...and the turn ran on the plain/non-local profile it started on,
    // rather than one detected from a llama-server that is not serving.
    expect(profileManager.getProfile().id).toBe(QWEN_THINK_PROFILE.id);
  });

  it("probes exactly once per local turn", async () => {
    const { loop, fetchProps, profileManager } = await buildLoop({
      isActive: () => true,
      ensureProbed: async () => false,
    });

    await runTurn(loop, "s-local");

    // One turn-start refresh. The between-steps `refreshIfStale` is a
    // no-op on a manager that is not stale, exactly as before #112.
    expect(fetchProps).toHaveBeenCalledTimes(1);
    expect(profileManager.getProfile().id).toBe("gemma4-think");
  });

  it("behaves as before the gate when no gate is wired (legacy deps)", async () => {
    const { loop, fetchProps } = await buildLoop(undefined);
    await runTurn(loop, "s-legacy");
    expect(fetchProps).toHaveBeenCalledTimes(1);
  });

  it("lazily restores local state on the first turn after a switch back to local", async () => {
    // Boot was cloud, so the probes were deferred; the operator has
    // since switched the active provider to a llama-server link.
    let active = false;
    const restore = vi.fn(async () => {});
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => active, restore },
      /* probedAtBoot */ false,
    );
    const { loop, fetchProps } = await buildLoop(gate);

    await runTurn(loop, "s-still-cloud");
    expect(restore).toHaveBeenCalledTimes(0);
    expect(fetchProps).toHaveBeenCalledTimes(0);

    active = true;
    await runTurn(loop, "s-switched");
    // The restore ran instead of the loop's own refresh — it already
    // carries a fresh `/props`, so the turn does not probe twice.
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fetchProps).toHaveBeenCalledTimes(0);

    // Every later local turn is back on the ordinary refresh.
    await runTurn(loop, "s-local-again");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fetchProps).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue #112 review, F1 — the SUSTAINED cloud→local fallover.
 *
 * `fallback.appendLocal` defaults to `true`, so a rate-limited or down
 * cloud primary falls over to the llama-server link on every turn under
 * the default config shape. The active text provider stays cloud for the
 * whole outage, which is what the loop's turn-start gate reads — so once
 * `ensureProbed()` had latched on the first fallover, nothing refreshed
 * the profile ever again and the prompt kept being built with the first
 * model's template. `main` refreshed unconditionally at every turn start
 * and did not have that hole.
 *
 * These tests drive the REAL `createFallbackCompleter` seam and the REAL
 * `DeferredLocalBackendProbes` through a real `AgentLoop`, with
 * `prepareLink` wired exactly as `bootstrap.ts` wires it, and hot-swap
 * the model behind the fake llama-server between turns 2 and 3.
 */
describe("AgentLoop — sustained cloud→local fallover keeps the profile live", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-loop-fallover-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  /** Cloud primary + llama-server tail, as `resolveFallbackChain` builds it. */
  const LLM: ResolvedLlmConfig = {
    activeTextProvider: "cloud",
    activeEmbeddingProvider: "cloud",
    providers: [
      { id: "cloud", kind: "openai" },
      { id: "local", kind: "llama-server" },
    ] as ResolvedLlmConfig["providers"],
    toolTransport: "auto",
  };

  function fakeProvider(
    id: string,
    transport: "grammar" | "native_tools",
    serve: () => Promise<CompletionResult>,
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
      toolCallAdapter:
        transport === "native_tools" ? openAiToolCallAdapter : null,
      streamConsumer: null,
      complete: serve,
      async *completeStream() {
        const result = await serve();
        yield {
          delta: result.content,
          reasoningDelta: "",
          done: true,
        } as StreamChunk;
        return result;
      },
      async describeImage() {
        throw new Error("no vision");
      },
      async health() {
        return { reachable: true, status: 200, error: null, latencyMs: 1 };
      },
      async close() {},
    } as unknown as LlmProvider;
  }

  const buildFalloverLoop = async () => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    // What the fake llama-server currently has loaded. Swapped mid-test.
    let loaded = {
      props: GEMMA4_PROPS as Record<string, unknown>,
      modelId: "gemma-4-it",
    };
    const fetchProps = vi.fn(async () => loaded.props);
    const healthProbes = vi.fn();

    const profileManager = new ModelProfileManager({
      llama: { fetchProps } as unknown as LlamaServerClient,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: grammar,
      // Boot was cloud, so nothing probed: the manager runs on the
      // synthesized default until something warms it.
      initialModelId: null,
    });

    const gate = new DeferredLocalBackendProbes(
      {
        // The active provider is cloud for the whole outage — the
        // fallover never changes it. This is the exact condition that
        // used to freeze the profile.
        isActive: () => false,
        restore: async () => {
          healthProbes();
          await profileManager.refresh();
        },
      },
      /* probedAtBoot */ false,
    );

    // The profile the prompt was actually built with, per local
    // completion. This is the assertion that matters: a stale profile
    // here means a stale chat template and a stale GBNF grammar.
    const servedWithProfile: string[] = [];
    const localServe = async (): Promise<CompletionResult> => {
      servedWithProfile.push(profileManager.getProfile().id);
      return makeCompletion(
        `</think><channel|>${JSON.stringify({
          tool: "finish",
          args: { summary: "done" },
        })}`,
        loaded.modelId,
      );
    };
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        fakeProvider("cloud", "native_tools", async () => {
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
      ["local", fakeProvider("local", "grammar", localServe)],
    ]);

    const llmComplete = createFallbackCompleter({
      fallbackChain: new ProviderFallbackChain({
        resolve: () => ({
          chain: ["cloud", "local"],
          timing: DEFAULT_FALLBACK_TIMING,
        }),
      }),
      resolveSlice: (providerId) => {
        const provider = providers.get(providerId)!;
        return { provider, transport: provider.capabilities.toolTransport };
      },
      // The REAL preparer `bootstrap.ts` wires into its seam deps, with
      // the same three collaborators — not a re-implementation of it.
      prepareLink: createLocalLinkPreparer({
        gate,
        isLocalLink: (providerId) => providerIdIsLlamaServer(LLM, providerId),
        refreshIfStale: () => profileManager.refreshIfStale(),
      }),
      recordUnaryUsage: () => {},
      recordStreamUsage: () => {},
    });

    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar,
      profile: QWEN_THINK_PROFILE,
      profileManager,
      localBackend: gate,
      llmComplete,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });

    return {
      loop,
      fetchProps,
      healthProbes,
      profileManager,
      servedWithProfile,
      swapModel: () => {
        loaded = {
          props: QWEN3_PROPS as Record<string, unknown>,
          modelId: "qwen3-30b-a3b-instruct-2507",
        };
      },
    };
  };

  const runTurn = async (loop: AgentLoop, id: string) =>
    loop.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "go",
      maxSteps: 2,
      signal: new AbortController().signal,
    });

  it("re-probes on every turn the local link serves, and follows a hot swap on turn 3", async () => {
    const t = await buildFalloverLoop();
    const propsAfter: number[] = [];

    // Turn 1 — cloud 429s, the chain falls over, the seam restores.
    await runTurn(t.loop, "s1");
    propsAfter.push(t.fetchProps.mock.calls.length);
    expect(t.healthProbes).toHaveBeenCalledTimes(1);

    // Turn 2 — still cloud-active, still falling over. The turn-start
    // refresh must run again: `ensureProbed()` has latched, so before
    // this fix nothing did.
    await runTurn(t.loop, "s2");
    propsAfter.push(t.fetchProps.mock.calls.length);

    // The operator swaps the model behind llama-server mid-outage.
    t.swapModel();

    // Turn 3 — the swap must be picked up BEFORE the prompt is built.
    await runTurn(t.loop, "s3");
    propsAfter.push(t.fetchProps.mock.calls.length);

    // One `/props` per turn, matching `main`'s unconditional turn-start
    // refresh. Cumulative: 1, 2, 3.
    expect(propsAfter).toEqual([1, 2, 3]);
    // The restore is still one-shot — turns 2 and 3 refresh, they do not
    // replay `/health`.
    expect(t.healthProbes).toHaveBeenCalledTimes(1);

    // The load-bearing assertion. Turn 3's completion was built with the
    // profile of the model llama-server is NOW serving. Pinned to
    // `gemma4-think` before this fix.
    expect(t.servedWithProfile).toEqual([
      "gemma4-think",
      "gemma4-think",
      "qwen-think",
    ]);
    expect(t.profileManager.getModelId()).toBe("qwen3-30b-a3b-instruct-2507");
  });

  it("goes quiet again within one turn of the cloud primary recovering", async () => {
    // The other half of take-and-clear: the refresh must not become a
    // permanent per-turn `/props` just because one fallover happened.
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => false, restore: async () => {} },
      /* probedAtBoot */ false,
    );
    gate.noteLinkServed();
    expect(gate.takeLinkServed()).toBe(true);
    expect(gate.takeLinkServed()).toBe(false);
  });
});
