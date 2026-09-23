import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { RunTurnOptions } from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
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
 * `RunTurnResult.stopCause`: whether a ceiling, rather than the model,
 * ended the task. The case it exists for is a `reply` on the forced
 * finalization step — the loop offered the model nothing but `reply`, so
 * the reply is a summary of how far the work got, and a fusion worker
 * that wrote "the step limit was reached before the file write could be
 * executed" there must not be read as having finished.
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

describe("AgentLoop stopCause", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-stop-cause-"));
    writeFileSync(join(workingDir, "notes.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (params: LlmStreamParams, call: number) => string) {
    const prompts: string[] = [];
    let call = 0;
    // The default registry carries only the terminals; one ordinary tool
    // is enough to spend a non-final step on.
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
        return completion(script(params, call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    return { agent, prompts };
  }

  function options(extra: Partial<RunTurnOptions>): RunTurnOptions {
    return {
      userMessage: "do the thing",
      maxSteps: 5,
      signal: new AbortController().signal,
      ...extra,
    };
  }

  it("leaves a reply on an ordinary step unmarked", async () => {
    const { agent } = loop(() => replyCall("all done"));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-plain", workingDir }),
      options({ maxSteps: 5, taskMaxSteps: 5 }),
    );
    expect(result.reason).toBe("reply");
    expect(result).not.toHaveProperty("stopCause");
  });

  it("marks a reply written on the step ceiling's forced final step", async () => {
    const { agent, prompts } = loop((_params, call) =>
      call === 1
        ? JSON.stringify([{ tool: "os.fs.read", args: { path: "notes.txt" } }])
        : replyCall("the step limit was reached before the write"),
    );
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-steps", workingDir }),
      options({ maxSteps: 2, taskMaxSteps: 2 }),
    );
    expect(result.session.lastError ?? null).toBeNull();
    expect(result.reason).toBe("reply");
    expect(result.stepCount).toBe(2);
    expect(result.stopCause).toBe("step_ceiling");
    // The marked step is the one the loop told it was final.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("This is the final allowed step");
    expect(prompts[1]).toContain("This is the final allowed step");
  });

  it("marks a reply forced by the time ceiling", async () => {
    const { agent } = loop(() => replyCall("out of time, here is where I got"));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-time", workingDir }),
      options({ maxSteps: 5, taskMaxSteps: 5, taskMaxDurationMs: 0 }),
    );
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBe("time_ceiling");
  });
});
