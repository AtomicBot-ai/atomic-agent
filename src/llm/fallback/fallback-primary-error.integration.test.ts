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
  ToolDescriptor,
} from "../../prompt/stable-prefix.js";
import type {
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "../provider/completion-types.js";
import type { LlmProvider } from "../provider/llm-provider.js";
import { openAiToolCallAdapter } from "../provider/openai/openai-tool-call-adapter.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { createFallbackCompleter } from "../../runtime/llm-fallback-seam.js";
import { createTraceRecorder } from "../../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../../tracing/trace/trace-event.js";
import { formatAgentErrorForChat } from "../../tui/format-agent-error-for-chat.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { describeFailedAttempts } from "./failed-attempts.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";

/**
 * The field report, end to end: OpenRouter answers 404 for a retired
 * model and the auto-appended llama-server is not running. Real loop, real
 * step executor (which re-wraps the thrown error), real seam, real trace
 * recorder — the note has to survive all of them, and nothing the loop
 * decides may change.
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

const CLOUD_404 =
  "openai provider 404: No endpoints found for z-ai/glm-5.3-flash.";

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

describe("an exhausted fallback chain, through the agent loop", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fallback-primary-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  async function runFailingTurn(options: {
    chain: string[];
    wait: boolean;
  }): Promise<{ events: AgentLoopEvent[]; trace: TraceEvent[]; calls: string[] }> {
    const calls: string[] = [];
    const providers = new Map<string, LlmProvider>([
      [
        "openrouter",
        failingProvider("openrouter", "native_tools", () => {
          calls.push("openrouter");
          return new OpenAiHttpError(
            CLOUD_404,
            404,
            "https://openrouter.ai/api/v1/chat/completions",
            false,
            null,
            "openrouter",
          );
        }),
      ],
      [
        "local",
        failingProvider("local", "grammar", () => {
          calls.push("local");
          return new TypeError("fetch failed");
        }),
      ],
    ]);
    const primary = providers.get(options.chain[0]!)!;
    const chain = new ProviderFallbackChain({
      resolve: () => ({ chain: options.chain, timing: DEFAULT_FALLBACK_TIMING }),
      // Below the probe throttle: a retried step stays on the fallback.
      now: () => 1_000,
    });
    const trace: TraceEvent[] = [];
    const recorder = createTraceRecorder({
      sessionId: "s-primary",
      emit: (e) => trace.push(e),
      now: () => 1,
    });
    const events: AgentLoopEvent[] = [];
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
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-primary", workingDir }),
      {
        userMessage: "go",
        maxSteps: 3,
        taskMaxSteps: 3,
        providerWaitEnabled: options.wait,
        // One 1 ms park, then give up: the shape of a five-minute wait.
        providerWaitMaxMs: 1,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    return { events, trace, calls };
  }

  function failure(events: AgentLoopEvent[]) {
    const failed = events.find((e) => e.type === "loop_failed");
    if (failed?.type !== "loop_failed") throw new Error("no loop_failed");
    return failed;
  }

  function chatText(events: AgentLoopEvent[]): string {
    const { category, error } = failure(events);
    return formatAgentErrorForChat(
      category,
      error.message,
      undefined,
      describeFailedAttempts(error),
    );
  }

  function lastErrorRow(trace: TraceEvent[]) {
    return trace.filter((e) => e.type === "error").at(-1);
  }

  it("fails as the lone local link does, and names the cloud's 404 beside it", async () => {
    const alone = await runFailingTurn({ chain: ["local"], wait: false });
    const both = await runFailingTurn({
      chain: ["openrouter", "local"],
      wait: false,
    });

    // Everything the loop decides is the last link's, unchanged.
    expect(failure(both.events).category).toBe(failure(alone.events).category);
    expect(failure(both.events).category).toBe("transport");
    expect(failure(both.events).error.message).toBe("fetch failed");
    expect(failure(both.events).error.constructor).toBe(
      failure(alone.events).error.constructor,
    );
    expect(both.calls).toEqual(["openrouter", "local"]);

    // A lone link renders byte for byte as before; the fallover says why.
    expect(chatText(alone.events)).toBe("Turn failed [transport]: fetch failed");
    expect(chatText(both.events)).toBe(
      `Turn failed [transport]: fetch failed (after "openrouter" failed: ${CLOUD_404})`,
    );

    expect(lastErrorRow(alone.trace)).not.toHaveProperty("fallbackFailures");
    expect(lastErrorRow(both.trace)).toMatchObject({
      message: "fetch failed",
      category: "transport",
      fallbackFailures: [{ providerId: "openrouter", reason: CLOUD_404 }],
    });
  });

  it("still names the 404 when the turn parks and gives up on the fallback", async () => {
    const { events, trace, calls } = await runFailingTurn({
      chain: ["openrouter", "local"],
      wait: true,
    });

    // The wait itself is untouched: same trigger, same raw reason.
    const waiting = events.filter((e) => e.type === "provider_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ reason: "fetch failed" });
    // The retried step went to the fallback only.
    expect(calls).toEqual(["openrouter", "local", "local"]);

    expect(chatText(events)).toBe(
      `Turn failed [transport]: fetch failed (after "openrouter" failed: ${CLOUD_404})`,
    );
    expect(lastErrorRow(trace)).toMatchObject({
      message: "fetch failed",
      fallbackFailures: [{ providerId: "openrouter", reason: CLOUD_404 }],
    });
  });
});
