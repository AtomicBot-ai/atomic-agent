import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../agent/agent-loop.js";
import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import { buildStreamEventHook } from "../../http/openai-chat-completions.js";
import { buildDefaultToolRegistry } from "../../tools/index.js";
import { SlotManager } from "../slot-manager.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { SessionState } from "../../session/session-state.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../../prompt/stable-prefix.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../provider/completion-types.js";
import type { LlmProvider } from "../provider/llm-provider.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { OpenAiProvider } from "../provider/openai/openai-provider.js";
import { createFallbackCompleter } from "../../runtime/llm-fallback-seam.js";
import { createFallbackChainResolver } from "../../runtime/fallback-chain-resolver.js";
import { createTraceRecorder } from "../../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../../tracing/trace/trace-event.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";

/**
 * Item 40, the field report (a desktop trace, 02.10): a chat on AI/ML API
 * with a good key said "hello". AI/ML API answered 403 "You've run out of
 * funds", DashScope (the configured fallback) had no key, and the
 * auto-appended local server had been stopped. The turn parked on the
 * local link's `fetch failed`, and the window said the local model server
 * was not running; the account was the whole problem.
 *
 * Real loop, step executor, seam, chain and chain resolver; AI/ML API is a
 * real `OpenAiProvider` over a fake `fetch` answering the field body, so
 * the error, its parsing and the sentence are the shipped ones.
 */

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

/** The field config, as the runtime resolves it: a plain key this time. */
const FIELD_LLM: ResolvedLlmConfig = {
  activeTextProvider: "aimlapi",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    { id: "aimlapi", kind: "aimlapi", apiKey: "sk-test-aiml-0123456789abcdef" },
    {
      id: "dashscope",
      kind: "openai-compatible",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
      defaultChatModel: "qwen-plus",
    },
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
  ],
  fallback: { chain: ["dashscope"] },
};

/** AI/ML API's answer for an account with no funds left. */
const OUT_OF_FUNDS = JSON.stringify({
  title: "Forbidden",
  status: 403,
  message:
    "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
});

const SENTENCE =
  '"aimlapi" refused the request: you\'ve run out of funds. Top up your balance with "aimlapi" or pick another provider in the Providers panel.';

function tracked(provider: LlmProvider, calls: string[]): LlmProvider {
  return {
    id: provider.id,
    name: provider.name,
    capabilities: provider.capabilities,
    toolCallAdapter: provider.toolCallAdapter,
    streamConsumer: provider.streamConsumer,
    complete: (request) => {
      calls.push(provider.id);
      return provider.complete(request);
    },
    completeStream: (request) => {
      calls.push(provider.id);
      return provider.completeStream(request);
    },
    describeImage: (request) => provider.describeImage(request),
    health: () => provider.health(),
    close: () => provider.close(),
  };
}

/** The stopped local server: every request is undici's `fetch failed`. */
function stoppedLocal(): LlmProvider {
  const serve = async (): Promise<CompletionResult> => {
    throw new TypeError("fetch failed");
  };
  return {
    id: "local-llama",
    name: "local-llama",
    capabilities: {
      vision: false,
      visionSource: "absent",
      toolTransport: "grammar",
      contextWindow: 128_000,
      supportsParallelTools: false,
      supportsSlotAffinity: true,
      supportsPromptCache: false,
      reasoningFormat: "none",
    },
    toolCallAdapter: null,
    streamConsumer: null,
    complete: serve,
    // eslint-disable-next-line require-yield
    async *completeStream(): AsyncGenerator<StreamChunk, CompletionResult> {
      return serve();
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

interface Frame {
  name: string | null;
  payload: Record<string, unknown>;
}

function fieldRig(workingDir: string) {
  const calls: string[] = [];
  const fetched: string[] = [];
  const warn = vi.fn();
  const aimlapi = new OpenAiProvider({
    id: "aimlapi",
    baseUrl: "https://api.aimlapi.com",
    apiKey: FIELD_LLM.providers[0]!.apiKey!,
    defaultChatModel: "openai/gpt-oss-20b",
    fetchImpl: (async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response(OUT_OF_FUNDS, {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const dashscope = new OpenAiProvider({
    id: "dashscope",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
    apiKey: "",
    defaultChatModel: "qwen-plus",
    fetchImpl: (async () => {
      throw new Error("the keyless link must not be asked");
    }) as typeof fetch,
  });
  const providers = new Map<string, LlmProvider>([
    ["aimlapi", tracked(aimlapi, calls)],
    ["dashscope", tracked(dashscope, calls)],
    ["local-llama", tracked(stoppedLocal(), calls)],
  ]);
  const chain = new ProviderFallbackChain({
    resolve: createFallbackChainResolver({
      readLlmConfig: () => FIELD_LLM,
      builtProviderIds: () => [...providers.keys()],
      logger: { warn },
    }),
    now: () => 1_000,
    logger: { warn },
  });
  const trace: TraceEvent[] = [];
  const recorder = createTraceRecorder({
    sessionId: "s-billing",
    emit: (e) => trace.push(e),
    now: () => 1,
  });
  // What the desktop reads: the turn's frames as `atag serve` writes them.
  const frames: Frame[] = [];
  const sse = buildStreamEventHook(
    {
      closed: false,
      writeEvent(name: string | null, payload: unknown) {
        frames.push({ name, payload: payload as Record<string, unknown> });
      },
    } as never,
    {
      completionId: "cmpl-1",
      created: 0,
      session: { id: "s-billing" },
      request: { model: "atomic-agent", extensionsEnabled: true },
    } as never,
  );
  const events: AgentLoopEvent[] = [];
  const primary = providers.get("aimlapi")!;
  const loop = new AgentLoop({
    registry: buildDefaultToolRegistry(),
    slotManager: new SlotManager(2),
    grammar: 'root ::= "ok"',
    llmComplete: createFallbackCompleter({
      fallbackChain: chain,
      resolveSlice: (id) => {
        const provider = providers.get(id)!;
        return { provider, transport: provider.capabilities.toolTransport };
      },
      recordUnaryUsage: () => {},
      recordStreamUsage: () => {},
    }),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: [],
    toolTransport: primary.capabilities.toolTransport,
    toolCallAdapter: primary.toolCallAdapter,
    supportsSlotAffinity: false,
    onEvent: (e) => {
      events.push(e);
      recorder.onAgentEvent(e);
      sse(e);
    },
  });

  let session: SessionState = createEmptySessionState({
    id: "s-billing",
    workingDir,
  });
  return {
    calls,
    fetched,
    trace,
    frames,
    async turn() {
      const eventsBefore = events.length;
      const callsBefore = calls.length;
      const result = await loop.runTurn(session, {
        userMessage: "hello",
        maxSteps: 3,
        taskMaxSteps: 3,
        providerWaitEnabled: true,
        // Short, so a turn that does park gives up at once instead of
        // after five minutes; whether it parked at all is the question.
        providerWaitMaxMs: 1,
        signal: new AbortController().signal,
      });
      session = result.session;
      return {
        result,
        events: events.slice(eventsBefore),
        calls: calls.slice(callsBefore),
      };
    },
  };
}

describe("item 40: the picked provider's account is empty and the local fallback is stopped", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fallback-billing-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("ends the turn at once with AI/ML API's own reason, not a wait on the local server", async () => {
    const rig = fieldRig(workingDir);
    const { result, events, calls } = await rig.turn();

    expect(result.reason).toBe("failed");
    expect(events.filter((e) => e.type === "provider_waiting")).toEqual([]);
    expect(events.some((e) => e.type === "credit_exhausted")).toBe(false);
    expect(calls).toEqual(["aimlapi", "local-llama"]);
    // One request: a billing refusal is not retried at the HTTP layer either.
    expect(rig.fetched).toHaveLength(1);
    expect(rig.fetched[0]).toContain("api.aimlapi.com");

    const failed = events.find((e) => e.type === "loop_failed");
    expect(failed?.type).toBe("loop_failed");
    if (failed?.type !== "loop_failed") return;
    expect(failed.category).toBe("transport");
    expect(failed.error.message).toBe(SENTENCE);

    const errorRows = rig.trace.filter((e) => e.type === "error");
    expect(errorRows.at(-1)).toMatchObject({ message: SENTENCE });
  });

  it("tells the desktop on the turn's first error frame: the sentence, and the cause as billing", async () => {
    const rig = fieldRig(workingDir);
    await rig.turn();

    const errors = rig.frames.filter((f) => f.name === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.payload).toEqual({
      error: SENTENCE,
      category: "transport",
      cause: { kind: "billing", status: 403 },
    });
    expect(rig.frames.some((f) => f.name === "provider_waiting")).toBe(false);
  });

  it("asks AI/ML API again on the next turn, not the local link that only stood in", async () => {
    const rig = fieldRig(workingDir);
    await rig.turn();
    const second = await rig.turn();

    expect(second.calls).toEqual(["aimlapi", "local-llama"]);
    expect(second.events.filter((e) => e.type === "provider_waiting")).toEqual([]);
    const failed = second.events.find((e) => e.type === "loop_failed");
    expect(failed?.type === "loop_failed" && failed.error.message).toBe(SENTENCE);
  });
});
