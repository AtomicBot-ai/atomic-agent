import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { dispatchSlashCommand } from "./commands/slash-command-handler.js";
import { formatTuiStatus, tuiTurnStatus } from "./status-snapshot-tui.js";
import type { ToolCardEntry } from "./tui-state.js";

// ATO-965: `/status` in the TUI.

type StatusInput = Parameters<typeof tuiTurnStatus>[0];

function card(extra: Partial<ToolCardEntry>): ToolCardEntry {
  return {
    id: "c",
    stepIndex: 0,
    tool: "os.fs.read",
    args: {},
    status: "ok",
    summary: "raw output",
    truncated: false,
    startedAt: 0,
    finishedAt: 1,
    ...extra,
  };
}

function running(extra: Partial<StatusInput> = {}): StatusInput {
  return {
    status: "running",
    runStartedAt: 0,
    currentStep: 4,
    streamingToolCalls: [],
    streamingToolCards: [],
    pendingApproval: null,
    runHistory: [],
    ...extra,
  };
}

describe("TUI /status", () => {
  it("is a registered command that asks the caller for a snapshot", () => {
    const result = dispatchSlashCommand("/status");
    expect(result.triggerStatusSnapshot).toBe(true);
    expect(result.forwardAsMessage).toBe(false);
  });

  it("describes the running turn: call in flight, last result, time, steps", () => {
    const text = formatTuiStatus(
      running({
        streamingToolCalls: [{ id: "x", stepIndex: 4, tool: "os.shell.run", args: {}, startedAt: 0 }],
        streamingToolCards: [
          card({ tool: "os.shell.run", details: { cmd: "npm", args: ["test"], exitCode: 0 } }),
        ],
      }),
      65_000,
    );
    expect(text).toBe(
      ["Now: Running os.shell.run", "Last result: tests passed", "Blocked: no · 1m 05s · 5 steps"].join("\n"),
    );
  });

  it("says it is blocked while an approval prompt is up", () => {
    const text = formatTuiStatus(
      running({
        status: "awaiting_approval",
        pendingApproval: { tool: "os.fs.write" } as ApprovalRequest,
        streamingToolCards: [card({ status: "error" })],
      }),
      1_000,
    );
    expect(text).toContain("Now: waiting for your approval of os.fs.write");
    expect(text).toContain("Last result: os.fs.read · failed");
    expect(text).toContain("Blocked: yes, on your approval of os.fs.write");
  });

  it("adds plan progress when the caller has it", () => {
    const text = formatTuiStatus(running(), 0, { done: 5, total: 8, current: "integration tests" });
    expect(text.split("\n")[0]).toBe("Plan: 5/8 · Now: integration tests");
  });

  it("falls back to the last finished run when idle", () => {
    const idle = running({
      status: "idle",
      runHistory: [
        { message: "m", outcome: "completed", reason: "reply", stepCount: 7, durationMs: 40_000, finishedAt: 100_000 },
      ],
    });
    expect(formatTuiStatus(idle, 999_999)).toBe("No turn is running.\nLast turn: 7 steps · 40s");
    expect(formatTuiStatus(running({ status: "idle" }), 0)).toBe("No turn is running.");
  });
});
