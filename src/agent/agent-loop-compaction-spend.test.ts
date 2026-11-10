import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { ContextCompactionControl, CompactionStepOptions } from "./compaction-control.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * Compaction spend counts toward the task budget (ATO-1322): the
 * summarizer's cost reaches the turn through `onSpend`, so a run whose
 * only paid calls are compaction still stops at `taskMaxCostUsd`.
 */

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const readCall = JSON.stringify([{ tool: "os.fs.read", args: { path: "notes.txt" } }]);
const replyCall = (text: string) => JSON.stringify([{ tool: "reply", args: { text } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "os.fs.read", summary: "Read a file.", argsSchema: '{"path": string}' },
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

/** A compaction control that reports `usd` on its first call and never rewrites the session. */
function spendingCompaction(usd: number): { control: ContextCompactionControl; calls: number[] } {
  const calls: number[] = [];
  const control: ContextCompactionControl = {
    open() {},
    close() {},
    beforeStep(_input: BuildPromptInput, options: CompactionStepOptions) {
      calls.push(calls.length + 1);
      if (calls.length === 1) options.onSpend?.(usd);
      return undefined;
    },
  };
  return { control, calls };
}

describe("AgentLoop compaction spend and the task budget", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-compaction-spend-"));
    writeFileSync(join(workingDir, "notes.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (call: number) => string, compaction: ContextCompactionControl) {
    const prompts: string[] = [];
    let call = 0;
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "Read a file.",
      readonly: true,
      run: async () =>
        compressToolResult({ tool: "os.fs.read", status: "ok", output: "hello", details: {} }),
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        prompts.push(params.prompt);
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      // The model itself is local and free: only compaction costs money.
      priceCompletion: () => undefined,
      compaction,
    });
    return { agent, prompts };
  }

  it("stops at the cap when compaction alone spent it", async () => {
    const { control } = spendingCompaction(1.5);
    const { agent, prompts } = loop(
      (call) => (call === 1 ? readCall : replyCall("stopped: compaction spent the budget")),
      control,
    );
    const result = await agent.runTurn(createEmptySessionState({ id: "s-compact-cap", workingDir }), {
      userMessage: "do the long thing",
      maxSteps: 10,
      taskMaxSteps: 10,
      taskMaxCostUsd: 1,
      signal: new AbortController().signal,
    });
    // Step 1 ran after the $1.50 compaction; step 2 is the forced summary.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("The spend budget for this task is used up");
    expect(prompts[1]).toContain("The spend budget for this task is used up ($1.50 of $1.00)");
    expect(result.stopCause).toBe("cost_ceiling");
    expect(result.spendUsd).toBeCloseTo(1.5, 6);
  });

  it("keeps going when compaction spend stays under the cap", async () => {
    const { control } = spendingCompaction(0.25);
    const { agent, prompts } = loop(
      (call) => (call <= 2 ? readCall : replyCall("done")),
      control,
    );
    const result = await agent.runTurn(createEmptySessionState({ id: "s-compact-under", workingDir }), {
      userMessage: "do the long thing",
      maxSteps: 10,
      taskMaxSteps: 10,
      taskMaxCostUsd: 1,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result).not.toHaveProperty("stopCause");
    expect(prompts.some((p) => p.includes("The spend budget"))).toBe(false);
    expect(result.spendUsd).toBeCloseTo(0.25, 6);
  });
});
