import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { RunTurnOptions } from "./agent-loop.js";
import { APPROVAL_TIME_LIMIT_REASON } from "./turn/approval-deadline.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * ATO-1367: a task's time limit ends a step parked on an approval
 * prompt. The tool below stands in for one waiting on the gate: it
 * resolves only when the loop's `denyPendingApprovals` dep is called.
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

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "os.fs.write", summary: "Write.", argsSchema: '{"path": string}' },
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

describe("AgentLoop approval wait and the task time limit (ATO-1367)", () => {
  let workingDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    workingDir = mkdtempSync(join(tmpdir(), "atomic-approval-deadline-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workingDir, { recursive: true, force: true });
  });

  function setup() {
    const denied: Array<{ sessionId: string; reason: string }> = [];
    let release: ((reason: string) => void) | null = null;
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.fs.write",
      description: "write, waiting on an approval nobody answers",
      readonly: false,
      run: (_args, ctx) =>
        new Promise((resolve, reject) => {
          release = (reason) =>
            resolve({ tool: "os.fs.write", status: "error", summary: `denied: ${reason}` });
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    let call = 0;
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => {
        call += 1;
        return completion(
          call === 1
            ? JSON.stringify([{ tool: "os.fs.write", args: { path: "a.txt" } }])
            : JSON.stringify([{ tool: "reply", args: { text: "out of time" } }]),
        );
      },
      denyPendingApprovals: (sessionId, reason) => {
        denied.push({ sessionId, reason });
        release?.(reason);
        release = null;
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    return { agent, denied };
  }

  function options(extra: Partial<RunTurnOptions>): RunTurnOptions {
    return {
      userMessage: "write the file",
      maxSteps: 10,
      taskMaxSteps: 10,
      signal: new AbortController().signal,
      ...extra,
    };
  }

  it("denies the waiting approval at the limit and ends on a summary step", async () => {
    const { agent, denied } = setup();
    const turn = agent.runTurn(
      createEmptySessionState({ id: "s-approval", workingDir }),
      options({ taskMaxDurationMs: 30_000 }),
    );
    await vi.advanceTimersByTimeAsync(29_000);
    expect(denied).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(denied).toEqual([{ sessionId: "s-approval", reason: APPROVAL_TIME_LIMIT_REASON }]);
    const result = await turn;
    expect(result.stopCause).toBe("time_ceiling");
  });

  it("never denies anything on a turn without a task time limit", async () => {
    const user = new AbortController();
    const { agent, denied } = setup();
    const turn = agent.runTurn(
      createEmptySessionState({ id: "s-chat", workingDir }),
      options({ signal: user.signal }),
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(denied).toEqual([]);
    user.abort();
    await turn.catch(() => undefined);
    expect(denied).toEqual([]);
  });
});
