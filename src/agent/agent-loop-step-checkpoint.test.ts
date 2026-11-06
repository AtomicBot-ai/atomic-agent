import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { StepCheckpoint } from "./agent-contract.js";
import type { SessionState } from "../session/session-state.js";
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
 * Per-step checkpoints (ATO-1109): every completed step that does not
 * end the turn is handed to `onStepCheckpoint` with the session as it
 * stands, so the runtime can make it durable before the next step. The
 * terminal step is not: the turn's own end writes that one.
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

describe("AgentLoop step checkpoints", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-step-checkpoint-"));
    writeFileSync(join(workingDir, "notes.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (call: number) => string): AgentLoop {
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
    return new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => {
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
  }

  const readCall = JSON.stringify([
    { tool: "os.fs.read", args: { path: "notes.txt" } },
  ]);

  it("checkpoints each completed step with the transcript so far, not the terminal one", async () => {
    const seen: Array<{ step: StepCheckpoint; turns: number; status: string }> = [];
    const agent = loop((call) => (call <= 2 ? readCall : replyCall("done")));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-checkpoint", workingDir }),
      {
        userMessage: "read it twice",
        maxSteps: 10,
        taskMaxSteps: 10,
        signal: new AbortController().signal,
        onStepCheckpoint: (session: SessionState, step: StepCheckpoint) => {
          seen.push({ step, turns: session.turns.length, status: session.status });
        },
      },
    );
    expect(result.reason).toBe("reply");
    expect(result.stepCount).toBe(3);
    expect(seen.map((s) => s.step)).toEqual([
      { stepIndex: 0, stepsTaken: 1 },
      { stepIndex: 1, stepsTaken: 2 },
    ]);
    // The second checkpoint carries more transcript than the first: the
    // step's call and result are in it.
    expect(seen[1]!.turns).toBeGreaterThan(seen[0]!.turns);
    expect(seen.every((s) => s.status === "running")).toBe(true);
  });

  it("goes on when a checkpoint throws", async () => {
    const agent = loop((call) => (call === 1 ? readCall : replyCall("done")));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-checkpoint-throws", workingDir }),
      {
        userMessage: "read it",
        maxSteps: 10,
        taskMaxSteps: 10,
        signal: new AbortController().signal,
        onStepCheckpoint: () => {
          throw new Error("database is locked");
        },
      },
    );
    expect(result.reason).toBe("reply");
    expect(result.stepCount).toBe(2);
  });
});
