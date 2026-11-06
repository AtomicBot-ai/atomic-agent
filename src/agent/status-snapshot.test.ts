import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "./agent-contract.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  buildStatusSnapshot,
  createSnapshotCadence,
  createTurnStatusTracker,
  describeResult,
  formatElapsed,
  formatStatusSnapshot,
  planProgressOf,
} from "./status-snapshot.js";

const MIN = 60_000;

function executed(result: Partial<CompressedToolResult> & { tool: string }): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: {
        status: "ok",
        summary: "raw output /Users/someone/secret.txt",
        details: {},
        truncated: false,
        ...result,
      },
      batchIndex: 0,
      batchSize: 1,
    },
  } as AgentLoopEvent;
}

function parsed(tool: string): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_parsed",
      call: { tool, args: {} },
      batchIndex: 0,
      batchSize: 1,
    },
  } as AgentLoopEvent;
}

function stepFinished(stepIndex: number): AgentLoopEvent {
  return { type: "step_finished", stepIndex, summary: "raw tail", durationMs: 10 } as AgentLoopEvent;
}

describe("formatStatusSnapshot", () => {
  it("prints the three-line card from the issue", () => {
    const snap = buildStatusSnapshot(
      {
        running: true,
        startedAt: 0,
        steps: 23,
        plan: { done: 5, total: 8, current: "integration tests" },
        lastResult: { text: "tests passed", ok: true },
      },
      2 * 60 * MIN + 14 * MIN,
    );
    expect(formatStatusSnapshot(snap, "telegram")).toBe(
      [
        "Plan: 5/8 · Now: integration tests",
        "Last result: tests passed",
        "Blocked: no · 2h 14m · 23 steps",
      ].join("\n"),
    );
  });

  it("says what is blocking the turn when an approval waits", () => {
    const snap = buildStatusSnapshot(
      { running: true, startedAt: 0, steps: 3, blockedOn: "os.shell.run" },
      40_000,
    );
    const text = formatStatusSnapshot(snap, "tui");
    expect(text).toContain("Now: waiting for your approval of os.shell.run");
    expect(text).toContain("Blocked: yes, on your approval of os.shell.run · 40s · 3 steps");
  });

  it("drops the plan part and the result line when there are none", () => {
    const snap = buildStatusSnapshot({ running: true, startedAt: 0, steps: 1 }, 5_000);
    expect(formatStatusSnapshot(snap, "tui")).toBe("Now: thinking\nBlocked: no · 5s · 1 step");
  });

  it("describes the last turn when none is running", () => {
    const snap = buildStatusSnapshot(
      {
        running: false,
        startedAt: 0,
        endedAt: 90_000,
        steps: 4,
        lastResult: { text: "os.fs.write · ok", ok: true },
      },
      10 * MIN,
    );
    expect(formatStatusSnapshot(snap, "telegram")).toBe(
      [
        "No turn is running in this chat.",
        "Last turn: 4 steps · 1m 30s",
        "Last result: os.fs.write · ok",
      ].join("\n"),
    );
    expect(
      formatStatusSnapshot(buildStatusSnapshot({ running: false, startedAt: null, steps: 0 }), "tui"),
    ).toBe("No turn is running.");
  });

  it("keeps a long plan step on one short line", () => {
    const snap = buildStatusSnapshot(
      { running: true, startedAt: 0, steps: 1, plan: { done: 0, total: 2, current: `a\n${"x".repeat(200)}` } },
      0,
    );
    expect(snap.currentLine!.length).toBeLessThanOrEqual("Now: ".length + 80);
    expect(snap.currentLine).not.toContain("\n");
  });
});

describe("formatElapsed", () => {
  it("scales from seconds to hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(5 * MIN + 3_000)).toBe("5m 03s");
    expect(formatElapsed(134 * MIN)).toBe("2h 14m");
  });
});

describe("createTurnStatusTracker", () => {
  it("follows steps, the call in flight and the last result", () => {
    let clock = 1_000;
    const t = createTurnStatusTracker({ now: () => clock });
    t.onEvent({ type: "turn_started", turnIndex: 0 } as AgentLoopEvent);
    t.onEvent({ type: "step_started", stepIndex: 0 } as AgentLoopEvent);
    t.onEvent(parsed("os.fs.read"));
    expect(t.state()).toMatchObject({ running: true, startedAt: 1_000, current: "Running os.fs.read" });
    t.onEvent(executed({ tool: "os.fs.read" }));
    t.onEvent(stepFinished(0));
    clock = 61_000;
    const s = t.state();
    expect(s).toMatchObject({ steps: 1, current: null, lastResult: { text: "os.fs.read · ok", ok: true } });
    expect(formatStatusSnapshot(buildStatusSnapshot(s, clock), "tui")).toBe(
      "Now: thinking\nLast result: os.fs.read · ok\nBlocked: no · 1m 00s · 1 step",
    );
  });

  it("never echoes raw tool output", () => {
    const t = createTurnStatusTracker({ startedAt: 0 });
    t.onEvent(executed({ tool: "os.fs.read", status: "error" }));
    const text = formatStatusSnapshot(buildStatusSnapshot(t.state(), 1), "telegram");
    expect(text).not.toContain("secret");
    expect(text).toContain("os.fs.read · failed");
  });

  it("ignores the reply and finish terminals", () => {
    const t = createTurnStatusTracker({ startedAt: 0 });
    t.onEvent(executed({ tool: "os.fs.write" }));
    t.onEvent(parsed("reply"));
    t.onEvent(executed({ tool: "reply" }));
    expect(t.state().lastResult?.text).toBe("os.fs.write · ok");
    expect(t.state().current).toBeNull();
  });

  it("reads plan progress from a plan_updated event, structurally", () => {
    const t = createTurnStatusTracker({ startedAt: 0 });
    t.onEvent({
      type: "plan_updated",
      plan: {
        items: [
          { step: "unit tests", status: "done" },
          { step: "integration tests", status: "in_progress" },
          { step: "docs", status: "pending" },
        ],
        updatedAt: 0,
      },
    } as unknown as AgentLoopEvent);
    expect(t.state().plan).toEqual({ done: 1, total: 3, current: "integration tests" });
  });

  it("clears the block once the call ran, and stops the clock at the end", () => {
    let clock = 0;
    const t = createTurnStatusTracker({ now: () => clock, startedAt: 0 });
    t.setBlockedOn("os.shell.run");
    expect(t.state().blockedOn).toBe("os.shell.run");
    t.onEvent(executed({ tool: "os.shell.run", details: { cmd: "ls", exitCode: 0 } }));
    expect(t.state().blockedOn).toBeNull();
    clock = 5_000;
    t.onEvent({ type: "loop_completed" } as unknown as AgentLoopEvent);
    clock = 50_000;
    const snap = buildStatusSnapshot(t.state(), clock);
    expect(snap.running).toBe(false);
    expect(snap.elapsedMs).toBe(5_000);
  });

  it("uses a caller's describer when one is given", () => {
    const t = createTurnStatusTracker({
      startedAt: 0,
      describe: ({ name, ok }) => ({ line: ok === undefined ? `Doing ${name}` : `Did ${name}` }),
    });
    t.onEvent(parsed("os.fs.read"));
    expect(t.state().current).toBe("Doing os.fs.read");
    t.onEvent(executed({ tool: "os.fs.read" }));
    expect(t.state().lastResult?.text).toBe("Did os.fs.read");
  });
});

describe("describeResult", () => {
  const shell = (details: Record<string, unknown>, status: "ok" | "error" = "ok") =>
    describeResult({ tool: "os.shell.run", status, summary: "", details, truncated: false });

  it("names a recognised test run by its verdict", () => {
    expect(shell({ cmd: "npm", args: ["test"], exitCode: 0 })).toEqual({ text: "tests passed", ok: true });
    expect(shell({ cmd: "pytest", args: [], exitCode: 1 })).toEqual({ text: "tests failed (exit 1)", ok: false });
  });

  it("gives any other command its exit code only", () => {
    expect(shell({ cmd: "git", args: ["status"], exitCode: 0 })).toEqual({ text: "os.shell.run · exit 0", ok: true });
    expect(shell({ cmd: "make", args: [], exitCode: 2 })).toEqual({ text: "os.shell.run · exit 2", ok: false });
    expect(shell({ cmd: "sleep", args: ["99"], timedOut: true })).toEqual({ text: "os.shell.run · timed out", ok: false });
  });
});

describe("planProgressOf", () => {
  it("rejects anything not shaped like a plan", () => {
    expect(planProgressOf(null)).toBeNull();
    expect(planProgressOf({ items: [] })).toBeNull();
    expect(planProgressOf({ items: "x" })).toBeNull();
  });
});

describe("createSnapshotCadence", () => {
  it("never fires on a short turn", () => {
    const c = createSnapshotCadence({ everySteps: 10, everyMs: 5 * MIN }, 0);
    expect(c.due(9, 4 * MIN)).toBe(false);
  });

  it("fires every N steps and every M minutes, counted from the last one", () => {
    const c = createSnapshotCadence({ everySteps: 10, everyMs: 5 * MIN }, 0);
    expect(c.due(10, MIN)).toBe(true);
    c.mark(10, MIN);
    expect(c.due(15, 3 * MIN)).toBe(false);
    expect(c.due(15, 6 * MIN)).toBe(true);
    c.mark(15, 6 * MIN);
    expect(c.due(25, 7 * MIN)).toBe(true);
  });

  it("is off when both triggers are 0, and polls no faster than every 30 s", () => {
    const off = createSnapshotCadence({ everySteps: 0, everyMs: 0 }, 0);
    expect(off.enabled).toBe(false);
    expect(off.due(1_000, 99 * MIN)).toBe(false);
    expect(off.pollMs).toBeNull();
    expect(createSnapshotCadence({ everySteps: 0, everyMs: 5 * MIN }, 0).pollMs).toBe(30_000);
    expect(createSnapshotCadence(null, 0).enabled).toBe(false);
  });
});
