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
});
