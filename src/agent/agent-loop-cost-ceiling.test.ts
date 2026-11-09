import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopDependencies, RunTurnOptions } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * The task spend ceiling (ATO-1108): each step's completion is priced
 * after it returns, and once the turn's spend reaches
 * `taskMaxCostUsd` the next step is the reserved summary step, the way
 * the time ceiling ends a task.
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
const replyCall = (text: string) =>
  JSON.stringify([{ tool: "reply", args: { text } }]);

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

describe("AgentLoop task spend ceiling", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cost-ceiling-"));
    writeFileSync(join(workingDir, "notes.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(
    script: (call: number) => string,
    priceCompletion?: AgentLoopDependencies["priceCompletion"],
  ) {
    const prompts: string[] = [];
    let call = 0;
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "Read a file.",
      readonly: true,
      run: async () =>
        compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: "hello",
          details: {},
        }),
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
      ...(priceCompletion ? { priceCompletion } : {}),
    });
    return { agent, prompts };
  }

  function options(extra: Partial<RunTurnOptions>): RunTurnOptions {
    return {
      userMessage: "do the long thing",
      maxSteps: 10,
      taskMaxSteps: 10,
      signal: new AbortController().signal,
      ...extra,
    };
  }

  const fortyCents = () => 0.4;

  it("makes the step after the one that crossed the cap the summary step", async () => {
    const { agent, prompts } = loop(
      (call) => (call <= 3 ? readCall : replyCall("stopped: spent $1.20 of $1.00 budget; read the notes")),
      fortyCents,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-cost", workingDir }),
      options({ taskMaxCostUsd: 1 }),
    );
    // Steps 1-3 spend $1.20; step 4 is the forced summary.
    expect(prompts).toHaveLength(4);
    expect(prompts[2]).not.toContain("The spend budget for this task is used up");
    expect(prompts[3]).toContain("The spend budget for this task is used up ($1.20 of $1.00)");
    expect(prompts[3]).toContain("stopped: spent $1.20 of $1.00 budget");
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBe("cost_ceiling");
    expect(result.stepCount).toBe(4);
    expect(result.spendUsd).toBeCloseTo(1.6, 6);
  });

  it("closes with a plain spend line when the summary step does not reply", async () => {
    const { agent } = loop(() => readCall, fortyCents);
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-cost-stalled", workingDir }),
      options({ taskMaxCostUsd: 1 }),
    );
    expect(result.reason).toBe("max_steps");
    expect(result.stopCause).toBe("cost_ceiling");
    expect(result.session.lastError).toMatch(/task_stopped:cost_ceiling/);
    const last = result.session.turns[result.session.turns.length - 1];
    expect(JSON.stringify(last)).toMatch(/stopped: spent \$1\.60 of \$1\.00 budget/);
  });

  it("changes nothing without a cap, but still reports the spend", async () => {
    const { agent, prompts } = loop(
      (call) => (call <= 3 ? readCall : replyCall("done")),
      fortyCents,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-no-cap", workingDir }),
      options({}),
    );
    expect(result.reason).toBe("reply");
    expect(result).not.toHaveProperty("stopCause");
    expect(prompts.some((p) => p.includes("The spend budget"))).toBe(false);
    expect(result.spendUsd).toBeCloseTo(1.6, 6);
  });

  it("never stops local work: unpriced completions count as $0", async () => {
    const { agent } = loop(
      (call) => (call <= 3 ? readCall : replyCall("done locally")),
      () => undefined,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-local", workingDir }),
      options({ taskMaxCostUsd: 0.01 }),
    );
    expect(result.reason).toBe("reply");
    expect(result).not.toHaveProperty("stopCause");
    expect(result.spendUsd).toBe(0);
  });

  it("prices every completion the provider returned, including thrown-away ones", async () => {
    const { agent, prompts } = loop(
      (call) => (call === 1 ? "{ not a tool call" : call <= 3 ? readCall : replyCall("done")),
      fortyCents,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-cost-retries", workingDir }),
      options({}),
    );
    // One $0.40 charge per completion requested, whatever the step did
    // with it (repair, retry, or commit).
    expect(result.spendUsd).toBeCloseTo(prompts.length * 0.4, 6);
  });

  it("reports no spend figure when no pricing seam is wired", async () => {
    const { agent } = loop(() => replyCall("hi"));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-unwired", workingDir }),
      options({ taskMaxCostUsd: 1 }),
    );
    expect(result.reason).toBe("reply");
    expect(result).not.toHaveProperty("spendUsd");
  });
});
