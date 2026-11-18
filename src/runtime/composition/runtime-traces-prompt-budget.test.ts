import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeTraces } from "./runtime-traces.js";
import type { SentryClient } from "../../error-reporting/index.js";
import { ModelError } from "../../llm/index.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

/**
 * ATO-1678 seam: the prompt a step built (`prompt_built`) is what the
 * `llm_failure` report of that turn's `loop_failed` describes, as
 * count-only `prompt_*` tags, plus the cut reply's `cut_*` counts.
 */
describe("llm_failure report carries the last prompt's budget (ATO-1678)", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "atomic-traces-budget-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigCache();
    await rm(stateDir, { recursive: true, force: true });
  });

  function setup() {
    const config = getConfig();
    config.tracing.trace.enabled = false;
    const traces = createRuntimeTraces(config, { handlers: {} }, logger);
    const capture = vi.fn();
    const reporter = { capture } as unknown as SentryClient;
    const routing = traces.createEventRouting({ emit: vi.fn() }, { handlers: {} }, () => reporter);
    const prompt = buildPrompt({
      session: createEmptySessionState({ id: "budget", workingDir: stateDir }),
      toolDescriptors: [], skillCatalog: [],
      capabilities: {
        platform: "win32", arch: "x64", browserChannel: "chrome", workingDir: stateDir,
        hasClipboard: false, hasWmctrl: false, hasNotifications: false,
      },
      contextWindow: 32_768,
      completionMaxTokens: 4096,
      toolTransport: "native_tools",
      toolSchemaTokens: 5_000,
    });
    const cut = new ModelError("truncated", "model response truncated", {
      truncation: { cause: "context_window", promptTokens: 30_100, completionTokens: 2_660, requestedMaxTokens: 8192 },
    });
    return { traces, routing, capture, prompt, cut };
  }

  function sentTags(capture: ReturnType<typeof vi.fn>): Record<string, string> {
    expect(capture).toHaveBeenCalledTimes(1);
    return (capture.mock.calls[0]![0] as { llmFailureTags?: Record<string, string> }).llmFailureTags ?? {};
  }

  it("tags the failure with the parts of the prompt built on that turn", () => {
    const { routing, capture, prompt, cut } = setup();
    routing.emitAgentLoopEventFor("budget", { type: "llm_event", event: { type: "prompt_built", prompt, slotId: -1 } });
    routing.emitAgentLoopEventFor("budget", { type: "loop_failed", error: cut, category: "model" });
    const tags = sentTags(capture);
    expect(tags.prompt_total_tokens).toBe(String(prompt.tokens.total));
    expect(tags.prompt_prefix_tokens).toBe(String(prompt.tokens.stablePrefix));
    expect(tags.prompt_tools_tokens).toBe("5000");
    expect(tags.prompt_window).toBe("32768");
    expect(tags.prompt_reply_reserve).toBe(String(prompt.replyReserve));
    expect(tags.cut_prompt_tokens).toBe("30100");
    expect(tags.cut_reply_tokens).toBe("2660");
  });

  it("sends no budget once the turn's usage was cleared, and none for another session", () => {
    const { traces, routing, capture, prompt, cut } = setup();
    routing.emitAgentLoopEventFor("budget", { type: "llm_event", event: { type: "prompt_built", prompt, slotId: -1 } });
    traces.clearContextUsage("budget");
    routing.emitAgentLoopEventFor("budget", { type: "loop_failed", error: cut, category: "model" });
    expect(sentTags(capture).prompt_total_tokens).toBeUndefined();
    capture.mockClear();
    routing.emitAgentLoopEventFor("budget", { type: "llm_event", event: { type: "prompt_built", prompt, slotId: -1 } });
    routing.emitAgentLoopEventFor("other", { type: "loop_failed", error: cut, category: "model" });
    expect(sentTags(capture).prompt_total_tokens).toBeUndefined();
  });
});
