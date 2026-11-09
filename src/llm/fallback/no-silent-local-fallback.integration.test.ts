import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
} from "../provider/completion-types.js";
import type { LlmProvider } from "../provider/llm-provider.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { openAiToolCallAdapter } from "../provider/openai/openai-tool-call-adapter.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { createFallbackCompleter } from "../../runtime/llm-fallback-seam.js";
import { createFallbackChainResolver } from "../../runtime/fallback-chain-resolver.js";
import type { FailureAction, FailureCauseId } from "../reliability/failure-catalog.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";

/**
 * ATO-349 / ATO-892: a cloud error never moves the turn onto a local
 * model the person did not pick, and never waits on one.
 *
 * The person's setup is the common one: OpenRouter picked, a local
 * llama-server entry configured (the desktop writes one on first run) but
 * not running, and no `llm.fallback` block. One turn per cloud error
 * class; each must end on OpenRouter's own reason with one action, and
 * the local link must never be asked.
 */

const TOOLS: ToolDescriptor[] = [
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
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

const URL = "https://openrouter.ai/api/v1/chat/completions";

const LLM: ResolvedLlmConfig = {
  activeTextProvider: "openrouter",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    { id: "openrouter", kind: "openrouter", apiKey: "sk-or-test" },
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
  ],
};

function provider(id: string, calls: string[], fail: () => Error): LlmProvider {
  const serve = async (): Promise<CompletionResult> => {
    calls.push(id);
    throw fail();
  };
  return {
    id,
    name: id,
    capabilities: {
      vision: false,
      visionSource: "absent",
      toolTransport: "native_tools",
      contextWindow: 128_000,
      supportsParallelTools: true,
      supportsSlotAffinity: false,
      supportsPromptCache: false,
      reasoningFormat: "none",
    },
    toolCallAdapter: openAiToolCallAdapter,
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

async function runTurn(
  workingDir: string,
  cloudError: () => Error,
): Promise<{ events: AgentLoopEvent[]; calls: string[] }> {
  const calls: string[] = [];
  const providers = new Map<string, LlmProvider>([
    ["openrouter", provider("openrouter", calls, cloudError)],
    // Not running: a refused connection, as the field report had it.
    ["local-llama", provider("local-llama", calls, () => new TypeError("fetch failed"))],
  ]);
  const warn = vi.fn();
  const chain = new ProviderFallbackChain({
    resolve: createFallbackChainResolver({
      readLlmConfig: () => LLM,
      builtProviderIds: () => [...providers.keys()],
      logger: { warn },
    }),
    now: () => 1_000,
    logger: { warn },
  });
  const events: AgentLoopEvent[] = [];
  const loop = new AgentLoop({
    registry: buildDefaultToolRegistry(),
    slotManager: new SlotManager(2),
    grammar: 'root ::= "ok"',
    llmComplete: createFallbackCompleter({
      fallbackChain: chain,
      resolveSlice: (id) => {
        const p = providers.get(id)!;
        return { provider: p, transport: p.capabilities.toolTransport };
      },
      recordUnaryUsage: () => {},
      recordStreamUsage: () => {},
    }),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: [],
    toolTransport: "native_tools",
    toolCallAdapter: openAiToolCallAdapter,
    supportsSlotAffinity: false,
    onEvent: (e) => events.push(e),
  });
  const result = await loop.runTurn(
    createEmptySessionState({ id: "s-no-silent", workingDir }),
    {
      userMessage: "hi",
      maxSteps: 3,
      taskMaxSteps: 3,
      providerWaitEnabled: true,
      // A turn that parks gives up at once; whether it parked on the
      // cloud link (fine) or a local one (the bug) is what is checked.
      providerWaitMaxMs: 1,
      signal: new AbortController().signal,
    },
  );
  expect(result.reason).toBe("failed");
  return { events, calls };
}

function http(status: number, message: string): OpenAiHttpError {
  return new OpenAiHttpError(`openrouter ${status}: ${message}`, status, URL, false, null, "openrouter");
}

const CASES: ReadonlyArray<[string, () => Error, FailureCauseId, FailureAction]> = [
  ["429 rate limit", () => http(429, "Rate limit exceeded"), "rate_limited", "retry"],
  ["503 provider down", () => http(503, "Service unavailable"), "provider_trouble", "retry"],
  ["401 bad key", () => http(401, "No auth credentials found"), "auth_rejected", "fix-key"],
  ["402 out of credit / quota", () => http(402, "Insufficient credits"), "out_of_credit", "switch-model"],
  ["404 model not found", () => http(404, "No endpoints found for vendor/gone"), "model_not_found", "switch-model"],
];

describe("ATO-349 / ATO-892: no silent switch to a local model on a cloud error", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-no-silent-fallback-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it.each(CASES)("%s: names the real reason and one action, never asks the local model", async (_name, err, cause, action) => {
    const { events, calls } = await runTurn(workingDir, err);

    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["openrouter"]));
    expect(events.some((e) => e.type === "provider_switched")).toBe(false);
    for (const wait of events.filter((e) => e.type === "provider_waiting")) {
      expect(wait).toMatchObject({ providerId: "openrouter" });
    }

    const failed = events.find((e) => e.type === "loop_failed");
    if (failed?.type !== "loop_failed") throw new Error("no loop_failed");
    expect(failed.failure).toMatchObject({ cause, action });
    expect(failed.failure?.phrase).toMatch(/\S/);
  });
});
