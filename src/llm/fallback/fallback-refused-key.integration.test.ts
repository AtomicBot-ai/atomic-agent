import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../agent/agent-loop.js";
import type { AgentLoopEvent } from "../../agent/agent-loop.js";
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
  ToolCallTransport,
} from "../provider/completion-types.js";
import type { LlmProvider } from "../provider/llm-provider.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { openAiToolCallAdapter } from "../provider/openai/openai-tool-call-adapter.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { OpenAiProvider } from "../provider/openai/openai-provider.js";
import { createFallbackCompleter } from "../../runtime/llm-fallback-seam.js";
import { createFallbackChainResolver } from "../../runtime/fallback-chain-resolver.js";
import { createTraceRecorder } from "../../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../../tracing/trace/trace-event.js";
import { formatAgentErrorForChat } from "../../tui/format-agent-error-for-chat.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { describeFailedAttempts } from "./failed-attempts.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";

/**
 * Item 29, the field report (desktop trace e508aeda, turn 1): the active
 * provider is AI/ML API with a key that has a non-ASCII character in it,
 * `llm.fallback.chain` names DashScope, whose entry carries no key, and
 * the auto-appended local server had been stopped by the switch to cloud.
 *
 * The turn parked on the local link's `fetch failed` and retried it for
 * five minutes, telling the user the model was not answering, while the
 * whole problem was the key. Real loop, step executor, seam, chain and
 * chain resolver; the two cloud links are real `OpenAiProvider`s over a
 * fake `fetch`, so the key guard and the 401 are the shipped ones.
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

const DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode";

/** The field config, as the runtime resolves it (keys already looked up). */
const FIELD_LLM: ResolvedLlmConfig = {
  activeTextProvider: "aimlapi",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    // A Cyrillic letter pasted into the key: it cannot go in a header.
    { id: "aimlapi", kind: "aimlapi", apiKey: "sk-test-aiml-кey" },
    {
      id: "dashscope",
      kind: "openai-compatible",
      baseUrl: DASHSCOPE_URL,
      defaultChatModel: "qwen-plus",
    },
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
  ],
  fallback: { chain: ["dashscope"] },
};

/** Records each completion a link is asked for, then lets it run. */
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

function failingProvider(
  id: string,
  transport: ToolCallTransport,
  fail: () => Error,
): LlmProvider {
  const serve = async (): Promise<CompletionResult> => {
    throw fail();
  };
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

interface Rig {
  calls: string[];
  /** URLs the cloud links' `fetch` was actually called with. */
  fetched: string[];
  warn: ReturnType<typeof vi.fn>;
  events: AgentLoopEvent[];
  trace: TraceEvent[];
  /** Runs one turn in the rig's session; returns that turn's events. */
  turn(): Promise<{ events: AgentLoopEvent[]; calls: string[] }>;
}

function fieldRig(workingDir: string): Rig {
  const calls: string[] = [];
  const fetched: string[] = [];
  const warn = vi.fn();
  const fakeFetch = (respond: () => Response) =>
    (async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return respond();
    }) as typeof fetch;

  const aimlapi = new OpenAiProvider({
    id: "aimlapi",
    baseUrl: "https://api.aimlapi.com",
    apiKey: FIELD_LLM.providers[0]!.apiKey!,
    defaultChatModel: "gpt-4o",
    // Never reached: the key cannot form a header, so nothing is sent.
    fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
  });
  const dashscope = new OpenAiProvider({
    id: "dashscope",
    baseUrl: DASHSCOPE_URL,
    apiKey: "",
    defaultChatModel: "qwen-plus",
    fetchImpl: fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    ),
  });
  const local = failingProvider(
    "local-llama",
    "grammar",
    () => new TypeError("fetch failed"),
  );
  const providers = new Map<string, LlmProvider>([
    ["aimlapi", tracked(aimlapi, calls)],
    ["dashscope", tracked(dashscope, calls)],
    ["local-llama", tracked(local, calls)],
  ]);

  const chain = new ProviderFallbackChain({
    resolve: createFallbackChainResolver({
      readLlmConfig: () => FIELD_LLM,
      builtProviderIds: () => [...providers.keys()],
      logger: { warn },
    }),
    // Inside the probe throttle for the whole test: what a turn retried a
    // few seconds later, or the user's next message, would see.
    now: () => 1_000,
    logger: { warn },
  });
  const trace: TraceEvent[] = [];
  const recorder = createTraceRecorder({
    sessionId: "s-field",
    emit: (e) => trace.push(e),
    now: () => 1,
  });
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
    },
  });

  let session: SessionState = createEmptySessionState({
    id: "s-field",
    workingDir,
  });
  return {
    calls,
    fetched,
    warn,
    events,
    trace,
    async turn() {
      const eventsBefore = events.length;
      const callsBefore = calls.length;
      const result = await loop.runTurn(session, {
        userMessage: "hi",
        maxSteps: 3,
        taskMaxSteps: 3,
        providerWaitEnabled: true,
        // Short, so a turn that does park gives up at once instead of
        // after five minutes; whether it parked at all is the question.
        providerWaitMaxMs: 1,
        signal: new AbortController().signal,
      });
      expect(result.reason).toBe("failed");
      session = result.session;
      return {
        events: events.slice(eventsBefore),
        calls: calls.slice(callsBefore),
      };
    },
  };
}

function loopFailure(events: AgentLoopEvent[]) {
  const failed = events.find((e) => e.type === "loop_failed");
  if (failed?.type !== "loop_failed") throw new Error("no loop_failed");
  return failed;
}

function waits(events: AgentLoopEvent[]) {
  return events.filter((e) => e.type === "provider_waiting");
}

describe("item 29: every link fails and the primary's key is the problem", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fallback-refused-key-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("ends the turn at once on AI/ML API's key, naming it, without parking", async () => {
    const rig = fieldRig(workingDir);
    const { events, calls } = await rig.turn();

    expect(waits(events)).toEqual([]);
    expect(calls).toEqual(["aimlapi", "local-llama"]);

    const { category, error } = loopFailure(events);
    expect(category).toBe("transport");
    expect(error.message).toContain('"aimlapi"');
    expect(error.message).toMatch(/API key/);
    expect(error.message).toMatch(/character/);
    expect(error.message).not.toMatch(/fetch failed/);

    // The TUI line is the key's sentence alone: nothing failed before it.
    expect(
      formatAgentErrorForChat(
        category,
        error.message,
        undefined,
        describeFailedAttempts(error),
      ),
    ).toBe(`Turn failed [transport]: ${error.message}`);
    const errorRows = rig.trace.filter((e) => e.type === "error");
    expect(errorRows.at(-1)).toMatchObject({ message: error.message });
    expect(errorRows.at(-1)).not.toHaveProperty("fallbackFailures");
  });

  it("never sends a request to the fallback link that has no key, and says it skipped it", async () => {
    const rig = fieldRig(workingDir);
    await rig.turn();

    expect(rig.calls).not.toContain("dashscope");
    expect(rig.fetched).toEqual([]);
    expect(rig.warn).toHaveBeenCalledWith(
      "llm: fallback link skipped (no key)",
      { id: "dashscope" },
    );
  });

  it("starts the next turn from AI/ML API again, not from the local link that only stood in", async () => {
    const rig = fieldRig(workingDir);
    await rig.turn();
    const second = await rig.turn();

    expect(second.calls).toEqual(["aimlapi", "local-llama"]);
    expect(waits(second.events)).toEqual([]);
    expect(loopFailure(second.events).error.message).toContain('"aimlapi"');
  });
});

describe("an outage on a healthy chain still parks the turn", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fallback-outage-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("waits on the local link, names it, and keeps the sticky retries", async () => {
    const calls: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "cloud",
        failingProvider("cloud", "native_tools", () => {
          calls.push("cloud");
          return new OpenAiHttpError(
            "openai provider 503: upstream unavailable",
            503,
            "https://cloud.example/v1/chat/completions",
            false,
            null,
            "cloud",
          );
        }),
      ],
      [
        "local-llama",
        failingProvider("local-llama", "grammar", () => {
          calls.push("local-llama");
          return new TypeError("fetch failed");
        }),
      ],
    ]);
    const chain = new ProviderFallbackChain({
      resolve: () => ({
        chain: ["cloud", "local-llama"],
        timing: DEFAULT_FALLBACK_TIMING,
      }),
      now: () => 1_000,
    });
    const events: AgentLoopEvent[] = [];
    const primary = providers.get("cloud")!;
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
      onEvent: (e) => events.push(e),
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-outage", workingDir }),
      {
        userMessage: "hi",
        maxSteps: 3,
        taskMaxSteps: 3,
        providerWaitEnabled: true,
        providerWaitMaxMs: 1,
        signal: new AbortController().signal,
      },
    );

    expect(result.reason).toBe("failed");
    const parked = waits(events);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      reason: "fetch failed",
      cause: { kind: "unreachable" },
      providerId: "local-llama",
    });
    // The primary went down (503): its cooldown keeps the retry on the
    // link it fell over to, exactly as before.
    expect(calls).toEqual(["cloud", "local-llama", "local-llama"]);
  });
});
