import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { planUpdateTool } from "../tools/plan/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * ATO-609 through the loop: with `replanEveryNSteps` on, every N
 * completed steps the next step's `### notice` asks the model to review
 * and resend its live plan. No extra inference: the prompt count equals
 * the step count. Off (the default) it never appears.
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

const shellStep = (n: number): string =>
  JSON.stringify([{ tool: "os.shell.run", args: { cmd: `ls dir-${n}` } }]);
const PLAN_STEP = JSON.stringify([
  {
    tool: "plan.update",
    args: { items: [{ step: "List the folders", status: "in_progress" }] },
  },
]);
const FINAL = JSON.stringify([{ tool: "reply", args: { text: "done" } }]);

const MARK = "[plan]";

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "os.shell.run", summary: "Run a command.", argsSchema: '{"cmd": string}' },
  {
    name: "plan.update",
    summary: "Replace the live plan.",
    argsSchema: "{ items: [{ step: string, status: string }] }",
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

describe("AgentLoop: re-plan every N steps (ATO-609)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-replan-cadence-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (call: number) => string) {
    const prompts: string[] = [];
    let call = 0;
    const registry = buildDefaultToolRegistry();
    registry.register(planUpdateTool);
    registry.register({
      name: "os.shell.run",
      description: "Run a command.",
      readonly: false,
      run: async () =>
        compressToolResult({ tool: "os.shell.run", status: "ok", output: "exit: 0" }),
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params: LlmStreamParams) => {
        prompts.push(params.prompt);
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    return { agent, prompts };
  }

  const asks = (prompts: string[]): number[] =>
    prompts.flatMap((prompt, index) => (prompt.includes(MARK) ? [index] : []));

  it("asks for a re-plan every N steps without an extra model call", async () => {
    const { agent, prompts } = loop((call) => (call <= 5 ? shellStep(call) : FINAL));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-replan-on", workingDir }),
      {
        userMessage: "list the folders",
        maxSteps: 20,
        replanEveryNSteps: 2,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    // Six steps, six prompts: the nudge rides on a step, it is not one.
    expect(prompts).toHaveLength(6);
    // After steps 1-2 and after steps 3-4.
    expect(asks(prompts)).toEqual([2, 4]);
    expect(prompts[2]).toContain("### notice");
    expect(prompts[2]).toContain("2 steps into this task and there is no written plan");
    // The counter is on the session: one step counted since the last ask.
    expect(result.session.stepsSinceReplan).toBe(2);
  });

  it("starts over when the model sends plan.update by itself", async () => {
    const { agent, prompts } = loop((call) =>
      call === 2 ? PLAN_STEP : call <= 4 ? shellStep(call) : FINAL,
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-replan-self", workingDir }),
      {
        userMessage: "list the folders",
        maxSteps: 20,
        replanEveryNSteps: 2,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(5);
    // plan.update on step 2 resets; steps 3-4 count up to the ask on 5.
    expect(asks(prompts)).toEqual([4]);
    expect(prompts[4]).toContain("steps since the plan was last reviewed; it is 0/1 done.");
  });

  it("is off by default", async () => {
    const { agent, prompts } = loop((call) => (call <= 5 ? shellStep(call) : FINAL));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-replan-off", workingDir }),
      { userMessage: "list the folders", maxSteps: 20, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(prompts).toHaveLength(6);
    expect(asks(prompts)).toEqual([]);
    expect(result.session).not.toHaveProperty("stepsSinceReplan");
  });
});
