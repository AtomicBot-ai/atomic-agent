import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../agent/agent-loop.js";
import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import { buildDefaultToolRegistry } from "../../tools/index.js";
import { SlotManager } from "../slot-manager.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../../prompt/stable-prefix.js";
import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "../provider/completion-types.js";
import type { LlmProvider } from "../provider/llm-provider.js";
import { openAiToolCallAdapter } from "../provider/openai/openai-tool-call-adapter.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { runWithFallback } from "./run-with-fallback.js";
import { QWEN_THINK_PROFILE } from "../model-profile.js";
import {
  createFallbackCompleter,
  createFallbackStreamer,
  type FallbackSeamDeps,
} from "../../runtime/llm-fallback-seam.js";

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

/**
 * Minimal fake provider. `serve` produces the completion (or throws) for
 * a given request; capabilities carry the transport so the fallback
 * wrapper can stamp `servedTransport` correctly.
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

function grammarFinish(): CompletionResult {
  // A grammar (llama-server) completion emits the tool-call array as plain
  // `content` and carries NO native `toolCalls`. To make the test actually
  // discriminate the parse transport, we ALSO attach a bogus native
  // `toolCalls` entry: if the response is (wrongly) parsed under the
  // primary's native transport, that bogus `reply` wins and the turn never
  // reaches `finish`; parsed under the served grammar transport, the
  // `content` array wins and the turn finishes. A real llama-server never
  // sets `toolCalls`, so this only ever changes the outcome when the parse
  // keys off the wrong (primary) transport — exactly the blocker.
  return {
    content: JSON.stringify({ tool: "finish", args: { summary: "done" } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "local-model",
    toolCalls: [
      { type: "function", function: { name: "reply", arguments: '{"text":"WRONG native parse"}' } },
    ],
  };
}

describe("provider fallback chain end-to-end through the agent loop", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fallback-e2e-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("primary native 429 falls over to a grammar local link that answers, turn does not fail, one provider_switched", async () => {
    // Geometry that reproduced the parsing blocker: primary is a
    // native_tools cloud provider, fallback is a grammar-only local
    // provider. The request went out grammar/native-agnostic; the reply
    // must be parsed with the SERVED (grammar) transport, not the primary.
    const primary = fakeProvider("cloud", "native_tools", async () => {
      throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
    });
    const local = fakeProvider("local", "grammar", async () => grammarFinish());
    const providers = new Map<string, LlmProvider>([
      ["cloud", primary],
      ["local", local],
    ]);

    const events: AgentLoopEvent[] = [];
    const notices: AgentLoopEvent[] = [];
    // Wire the notice sink exactly as bootstrap does: each one-shot switch
    // becomes a `provider_switched` AgentLoopEvent on the same event path.
    const chain = new ProviderFallbackChain({
      resolve: () => ({
        chain: ["cloud", "local"],
        timing: DEFAULT_FALLBACK_TIMING,
      }),
      noticeSink: (n) => {
        const ev: AgentLoopEvent = { type: "provider_switched", ...n };
        events.push(ev);
        notices.push(ev);
      },
    });

    // Bootstrap-style closure: re-resolve transport per chosen link and
    // stamp `servedTransport` on the result (the real fix under test).
    const llmComplete = (params: {
      prompt: string;
      grammar: string;
      slotId: number;
      sessionId?: string;
      signal?: AbortSignal;
      tools?: ReadonlyArray<Record<string, unknown>>;
    }): Promise<CompletionResult> =>
      runWithFallback(chain, async (providerId) => {
        const provider = providers.get(providerId)!;
        const transport = provider.capabilities.toolTransport;
        const base = {
          prompt: params.prompt,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
        };
        const result =
          transport === "native_tools"
            ? await provider.complete({ ...base, ...(params.tools ? { tools: params.tools } : {}) })
            : await provider.complete({
                ...base,
                grammar: params.grammar,
                slotId: params.slotId,
                cachePrompt: params.slotId >= 0,
              });
        return { ...result, servedTransport: transport };
      });

    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      // Getters reflect the PRIMARY (native) — this is what made the bug
      // silent: the parse used to key off these, not the served link.
      toolTransport: "native_tools",
      toolCallAdapter: openAiToolCallAdapter,
      supportsSlotAffinity: false,
      onEvent: (e) => events.push(e),
    });

    const session = createEmptySessionState({ id: "s-e2e", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    // Turn must reach the fallback's finish, NOT fall into loop_failed.
    expect(result.reason).toBe("finish");
    expect(result.session.status).toBe("completed");
    expect(result.session.latestResult?.tool).toBe("finish");
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);

    // Exactly one provider_switched (away), carrying the served link.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: "provider_switched",
      direction: "away",
      to: "local",
    });
  });

  it("streaming path: primary 429 falls over to a grammar link and the streamed reply parses under the served transport", async () => {
    const primary = fakeProvider("cloud", "native_tools", async () => {
      throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
    });
    const local = fakeProvider("local", "grammar", async () => grammarFinish());
    const providers = new Map<string, LlmProvider>([
      ["cloud", primary],
      ["local", local],
    ]);
    const chain = new ProviderFallbackChain({
      resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }),
    });

    const llmCompleteStream = (params: {
      prompt: string;
      grammar: string;
      slotId: number;
      sessionId?: string;
      signal?: AbortSignal;
      tools?: ReadonlyArray<Record<string, unknown>>;
    }): AsyncGenerator<StreamChunk, CompletionResult, void> => {
      async function* run(): AsyncGenerator<StreamChunk, CompletionResult, void> {
        // First-chunk priming happens implicitly here: the 429 throws
        // before any yield, so runWithFallback advances to the local link.
        let served: ToolCallTransport = "grammar";
        const gen = await runWithFallback(chain, async (providerId) => {
          const provider = providers.get(providerId)!;
          served = provider.capabilities.toolTransport;
          const base = {
            prompt: params.prompt,
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          };
          const stream =
            served === "native_tools"
              ? provider.completeStream({ ...base, ...(params.tools ? { tools: params.tools } : {}) })
              : provider.completeStream({
                  ...base,
                  grammar: params.grammar,
                  slotId: params.slotId,
                  cachePrompt: params.slotId >= 0,
                });
          // Prime the first step so an open-time throw advances the chain.
          const first = await stream.next();
          return { first, rest: stream };
        });
        if (!gen.first.done) yield gen.first.value;
        const result = gen.first.done ? gen.first.value : yield* gen.rest;
        return { ...result, servedTransport: served };
      }
      return run();
    };

    const events: AgentLoopEvent[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => grammarFinish(),
      llmCompleteStream,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      toolTransport: "native_tools",
      toolCallAdapter: openAiToolCallAdapter,
      supportsSlotAffinity: false,
      onEvent: (e) => events.push(e),
    });

    const session = createEmptySessionState({ id: "s-e2e-stream", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    expect(result.reason).toBe("finish");
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);
  });

  // --- think-tag profile fallover (issue #283 review) -------------------
  // The documented default hybrid chain (`appendLocal`): a native-tools
  // cloud primary with a grammar llama-server last resort, on a
  // think-tag profile. These cases run the REAL bootstrap seams
  // (`createFallbackCompleter` / `createFallbackStreamer`) so the
  // per-chunk `servedTransport` stamp and the per-link prompt
  // substitution are pinned end-to-end, not re-implemented inline.

  function thinkSeamDeps(providers: Map<string, LlmProvider>): FallbackSeamDeps {
    const chain = new ProviderFallbackChain({
      resolve: () => ({
        chain: ["cloud", "local"],
        timing: DEFAULT_FALLBACK_TIMING,
      }),
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

  function thinkFinish(): CompletionResult {
    // Grammar output starts mid-think: the GBNF prelude root emits
    // `body "</think>"` without the open tag.
    return {
      content:
        'deliberating about the wrap-up</think>\n{"tool":"finish","args":{"summary":"done"}}',
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: "local-model",
    };
  }

  it("think profile, streaming: a grammar-served fallover stream keeps LIVE reasoning deltas and the prefill-carrying prompt shape", async () => {
    const cloudPrompts: string[] = [];
    const localPrompts: string[] = [];
    const primary = fakeProvider("cloud", "native_tools", async (request) => {
      cloudPrompts.push(request.prompt);
      throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
    });
    const local: LlmProvider = {
      ...fakeProvider("local", "grammar", async () => thinkFinish()),
      // Stream in several chunks so live classification is observable:
      // the reasoning text must surface as deltas BEFORE the stream ends.
      async *completeStream(request) {
        localPrompts.push(request.prompt);
        yield { delta: "deliberating about", reasoningDelta: "", done: false };
        yield { delta: " the wrap-up</think>\n", reasoningDelta: "", done: false };
        yield {
          delta: '{"tool":"finish","args":{"summary":"done"}}',
          reasoningDelta: "",
          done: true,
        };
        return thinkFinish();
      },
    };
    const providers = new Map<string, LlmProvider>([
      ["cloud", primary],
      ["local", local],
    ]);
    const seamDeps = thinkSeamDeps(providers);

    const events: AgentLoopEvent[] = [];
    const reasoningDeltas: string[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: createFallbackCompleter(seamDeps),
      llmCompleteStream: createFallbackStreamer(seamDeps),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: QWEN_THINK_PROFILE,
      toolTransport: "native_tools",
      toolCallAdapter: openAiToolCallAdapter,
      supportsSlotAffinity: false,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "llm_event" && e.event.type === "reasoning_delta") {
          reasoningDeltas.push(e.event.text);
        }
      },
    });

    const session = createEmptySessionState({ id: "s-e2e-think-stream", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    expect(result.reason).toBe("finish");
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);
    // Live reasoning classification survives the cross-transport
    // fallover: the grammar-served stream starts mid-`<think>`, and the
    // parser adopted the served transport from the chunk stamp.
    expect(reasoningDeltas.join("")).toBe("deliberating about the wrap-up");
    // Per-link prompt shapes: the chat primary got the prefill-suppressed
    // prompt (issue #283), the grammar link got the legacy
    // prefill-carrying variant its template + GBNF prelude expect.
    expect(cloudPrompts).toHaveLength(1);
    expect(cloudPrompts[0]!.trimEnd().endsWith("<think>")).toBe(false);
    expect(localPrompts).toHaveLength(1);
    expect(localPrompts[0]!.trimEnd().endsWith("<think>")).toBe(true);
  });

  it("think profile, unary: a grammar-served fallover completion still surfaces its reasoning and reaches finish", async () => {
    const localPrompts: string[] = [];
    const primary = fakeProvider("cloud", "native_tools", async () => {
      throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
    });
    const local = fakeProvider("local", "grammar", async (request) => {
      localPrompts.push(request.prompt);
      return thinkFinish();
    });
    const providers = new Map<string, LlmProvider>([
      ["cloud", primary],
      ["local", local],
    ]);
    const seamDeps = thinkSeamDeps(providers);

    const events: AgentLoopEvent[] = [];
    const reasoningEvents: string[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: createFallbackCompleter(seamDeps),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: QWEN_THINK_PROFILE,
      toolTransport: "native_tools",
      toolCallAdapter: openAiToolCallAdapter,
      supportsSlotAffinity: false,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "llm_event" && e.event.type === "reasoning") {
          reasoningEvents.push(e.event.text);
        }
      },
    });

    const session = createEmptySessionState({ id: "s-e2e-think-unary", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    expect(result.reason).toBe("finish");
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);
    expect(reasoningEvents).toEqual(["deliberating about the wrap-up"]);
    expect(localPrompts).toHaveLength(1);
    expect(localPrompts[0]!.trimEnd().endsWith("<think>")).toBe(true);
  });
});
