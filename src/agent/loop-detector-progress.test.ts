import { describe, expect, it } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { READ_REPEAT_WARNING_THRESHOLD, ToolLoopTracker } from "./loop-detector.js";
import type { BatchLoopSignal } from "./dispatch/batch-contract.js";
import { observeReadCoverage, runSyncLoopGate } from "./dispatch/batch-gates.js";
import { toBatchInputs } from "./dispatch/batch-scheduler.js";
import { MAX_FAILED_EPOCHS } from "./progress/mutation-epochs.js";
import { READ_COVERAGE_DETAIL_KEY } from "../tools/os/fs/fs-read-coverage.js";

type Call = { tool: string; args: Record<string, unknown> };

function mkResult(overrides: Partial<CompressedToolResult> = {}): CompressedToolResult {
  return { tool: "t", status: "ok", summary: "ok", details: {}, truncated: false, ...overrides };
}

const okOf = (call: Call): CompressedToolResult =>
  mkResult({ tool: call.tool, summary: `content of ${JSON.stringify(call.args)}` });

/**
 * One model step through the real loop gate. `parallel`: every call is
 * gated before any outcome lands (`executeBatch`). `in_order`: each call
 * is gated and recorded before the next one (`executeCallsInOrder` and
 * approval barriers run a step as length-1 batches with one step index).
 * Every recorded outcome also goes through the read-coverage observer, as
 * `executeBatch` does.
 */
function runStep(
  tracker: ToolLoopTracker,
  stepIndex: number,
  calls: Call[],
  mode: "parallel" | "in_order",
  outcomeOf: (call: Call) => CompressedToolResult = okOf,
): { proceeded: boolean[]; signals: BatchLoopSignal[] } {
  const signals: BatchLoopSignal[] = [];
  const proceeded: boolean[] = [];
  const ctx = { workingDir: "/repo", sessionId: "s", stepIndex, signal: new AbortController().signal, tracker };
  const inputs = toBatchInputs(calls);
  const ran: typeof inputs = [];
  const record = (input: (typeof inputs)[number]): void => {
    const call = input.call as Call;
    const result = outcomeOf(call);
    tracker.recordOutcome(call.tool, call.args, result);
    observeReadCoverage(input, result, tracker, signals);
  };
  for (const input of inputs) {
    const gate = runSyncLoopGate(input, ctx, signals);
    proceeded.push(gate.proceed);
    if (!gate.proceed) continue;
    if (mode === "in_order") record(input);
    else ran.push(input);
  }
  for (const input of ran) record(input);
  return { proceeded, signals };
}

const fetches = (from: number, n: number, tool = "os.web.fetch"): Call[] =>
  Array.from({ length: n }, (_, i) => ({ tool, args: { url: `https://docs.test/page-${from + i}` } }));

const stops = (signals: BatchLoopSignal[]) => signals.filter((s) => s.kind !== "warn");

describe("wandering detector: siblings of one step are one fan-out (ATO-999, #828)", () => {
  it("runs a 19-call step executed in emitted order past both the run cap (12) and the window ceiling (18)", () => {
    const tracker = new ToolLoopTracker();
    const { proceeded, signals } = runStep(tracker, 0, fetches(0, 19, "os.http.request"), "in_order");
    expect(proceeded.every(Boolean)).toBe(true);
    expect(stops(signals)).toEqual([]);
  });

  it("runs the reported research turn: 4, 4, 3 and 2 parallel fetches over four steps", () => {
    const tracker = new ToolLoopTracker();
    let next = 0;
    [4, 4, 3, 2].forEach((width, step) => {
      const { proceeded, signals } = runStep(tracker, step, fetches(next, width), "parallel");
      next += width;
      expect(proceeded.every(Boolean)).toBe(true);
      expect(stops(signals)).toEqual([]);
    });
  });

  it("still stops one distinct probe per step at the 12th step (true churn)", () => {
    const tracker = new ToolLoopTracker();
    for (let step = 0; step < 11; step += 1) {
      const { signals } = runStep(tracker, step, [{ tool: "os.web.search", args: { query: `q${step}` } }], "parallel");
      expect(stops(signals)).toEqual([]);
    }
    const { proceeded, signals } = runStep(tracker, 11, [{ tool: "os.web.search", args: { query: "q11" } }], "parallel");
    expect(proceeded).toEqual([false]);
    expect(stops(signals)).toEqual([expect.objectContaining({ kind: "breaker", detector: "wandering", count: 12 })]);
  });

  it("still bounds wide fan-outs step after step with the window ceiling", () => {
    const tracker = new ToolLoopTracker();
    for (let step = 0; step < 3; step += 1) {
      const { signals } = runStep(tracker, step, fetches(step * 8, 8, "os.web.search"), "parallel");
      expect(stops(signals)).toEqual([]);
    }
    tracker.noteStep(3);
    expect(tracker.wanderingStop("os.web.search", { url: "https://docs.test/page-24" })).toMatchObject({
      escalated: true,
      rule: "ceiling",
    });
    const { signals } = runStep(tracker, 3, fetches(24, 8, "os.web.search"), "parallel");
    expect(signals.some((s) => s.kind === "breaker" && s.detector === "wandering")).toBe(true);
  });

  it("still vetoes the same call repeated across steps with the same result", () => {
    const tracker = new ToolLoopTracker();
    const same: Call = { tool: "os.web.fetch", args: { url: "https://docs.test/dead" } };
    const deadEnd = () => mkResult({ tool: "os.web.fetch", summary: "404 not found" });
    for (let step = 0; step < 5; step += 1) {
      expect(runStep(tracker, step, [same], "parallel", deadEnd).proceeded).toEqual([true]);
    }
    const { proceeded, signals } = runStep(tracker, 5, [same], "parallel", deadEnd);
    expect(proceeded).toEqual([false]);
    expect(signals.some((s) => s.kind === "critical" && s.detector === "no_progress")).toBe(true);
  });
});

describe("read after a failed edit is not a no-progress repeat (ATO-1000, #827)", () => {
  const read: Call = { tool: "os.fs.read", args: { path: "service.py", offset: 1, limit: 50 } };
  // A classified read result, as `os.fs.read` returns it, so the
  // read-coverage observer sees the same file version and lines each time.
  const sameText = () =>
    mkResult({
      tool: "os.fs.read",
      summary: "1|def handler():\n2|    return 1",
      details: {
        [READ_COVERAGE_DETAIL_KEY]: {
          path: "/repo/service.py",
          contentHash: "v1",
          startLine: 1,
          endLine: 50,
          totalLines: 80,
          numbered: true,
          truncated: false,
        },
      },
    });
  const notFound = () =>
    mkResult({
      tool: "os.fs.edit",
      status: "error",
      summary: "os.fs.edit: `oldString` was not found in the target file.",
      details: { errorName: "Error" },
    });
  const editOf = (path: string, attempt: number): Call => ({
    tool: "os.fs.edit",
    args: { path, oldString: `return  ${attempt}`, newString: "return 2" },
  });
  const outcome = (call: Call) => (call.tool === "os.fs.read" ? sameText() : notFound());

  /** Read-repeat warnings the agent loop would actually show (agent-loop.ts gate). */
  const shownReadWarnings = (tracker: ToolLoopTracker, signals: BatchLoopSignal[]) =>
    signals.filter(
      (s) =>
        s.detector === "read_repeat" &&
        tracker.shouldEmitWarning(s.warningKey, s.count, READ_REPEAT_WARNING_THRESHOLD),
    );

  it("lets the model re-read after each of its first failed edits, with no veto and no warning shown", () => {
    const tracker = new ToolLoopTracker();
    let step = 0;
    runStep(tracker, step++, [read], "parallel", outcome);
    for (let attempt = 0; attempt < MAX_FAILED_EPOCHS; attempt += 1) {
      runStep(tracker, step++, [editOf("service.py", attempt)], "parallel", outcome);
      const { proceeded, signals } = runStep(tracker, step++, [read], "parallel", outcome);
      expect(proceeded).toEqual([true]);
      // Not even an advisory: the re-read is the recovery the error asked for.
      expect(signals.filter((s) => s.tool === "os.fs.read" && s.kind !== "warn")).toEqual([]);
      expect(shownReadWarnings(tracker, signals)).toEqual([]);
      expect(signals.filter((s) => s.detector === "generic_repeat")).toEqual([]);
    }
  });

  it("shows the read-coverage warning when the same re-read has nothing attempted before it", () => {
    const tracker = new ToolLoopTracker();
    runStep(tracker, 0, [read], "parallel", outcome);
    runStep(tracker, 1, [read], "parallel", outcome);
    const { signals } = runStep(tracker, 2, [read], "parallel", outcome);
    expect(shownReadWarnings(tracker, signals)).toHaveLength(1);
  });

  it("vetoes identical re-reads again once failed edits with different oldStrings stop opening epochs", () => {
    const tracker = new ToolLoopTracker();
    let step = 0;
    let vetoedAt = -1;
    runStep(tracker, step++, [read], "parallel", outcome);
    for (let attempt = 0; attempt < 20 && vetoedAt < 0; attempt += 1) {
      runStep(tracker, step++, [editOf("service.py", attempt)], "parallel", outcome);
      const { proceeded } = runStep(tracker, step++, [read], "parallel", outcome);
      if (!proceeded[0]) vetoedAt = attempt;
    }
    // Three failed edits open epochs; from the fourth on the re-reads share
    // one epoch, and the sixth of them is the usual no-progress veto.
    expect(vetoedAt).toBe(MAX_FAILED_EPOCHS - 1 + 5);
  });

  it("opens epochs again once a change lands", () => {
    const tracker = new ToolLoopTracker();
    let step = 0;
    runStep(tracker, step++, [read], "parallel", outcome);
    for (let attempt = 0; attempt < MAX_FAILED_EPOCHS + 2; attempt += 1) {
      runStep(tracker, step++, [editOf("service.py", attempt)], "parallel", outcome);
      runStep(tracker, step++, [read], "parallel", outcome);
    }
    const landed = mkResult({ tool: "os.fs.edit", summary: "edited service.py" });
    runStep(tracker, step++, [editOf("service.py", 99)], "parallel", () => landed);
    for (let attempt = 0; attempt < MAX_FAILED_EPOCHS; attempt += 1) {
      runStep(tracker, step++, [editOf("service.py", 100 + attempt)], "parallel", outcome);
      expect(runStep(tracker, step++, [read], "parallel", outcome).proceeded).toEqual([true]);
    }
  });

  it("matches the edit's relative path to the read's absolute one", () => {
    const tracker = new ToolLoopTracker();
    const absRead: Call = { tool: "os.fs.read", args: { path: "/repo/src/service.py" } };
    let step = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect(runStep(tracker, step++, [absRead], "parallel", outcome).proceeded).toEqual([true]);
      runStep(tracker, step++, [editOf("./src/service.py", attempt)], "parallel", outcome);
    }
  });

  it("still vetoes the same read repeated with nothing attempted in between", () => {
    const tracker = new ToolLoopTracker();
    for (let step = 0; step < 5; step += 1) {
      expect(runStep(tracker, step, [read], "parallel", outcome).proceeded).toEqual([true]);
    }
    expect(runStep(tracker, 5, [read], "parallel", outcome).proceeded).toEqual([false]);
  });

  it("still vetoes the read when the failed edits are on a different file", () => {
    const tracker = new ToolLoopTracker();
    let step = 0;
    let vetoed = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { proceeded } = runStep(tracker, step++, [read], "parallel", outcome);
      if (!proceeded[0]) vetoed = true;
      runStep(tracker, step++, [editOf("other.py", attempt)], "parallel", outcome);
    }
    expect(vetoed).toBe(true);
  });

  it("still vetoes an edit that keeps failing the same way, while its re-reads run", () => {
    const tracker = new ToolLoopTracker();
    const stuck = editOf("service.py", 0);
    let step = 0;
    let editVetoed = false;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect(runStep(tracker, step++, [read], "parallel", outcome).proceeded).toEqual([true]);
      const { proceeded } = runStep(tracker, step++, [stuck], "parallel", outcome);
      if (!proceeded[0]) editVetoed = true;
    }
    expect(editVetoed).toBe(true);
  });

  it("does not count the re-read toward the read-coverage count (tracker level)", () => {
    const tracker = new ToolLoopTracker();
    const observed = {
      path: "/repo/service.py",
      contentHash: "v1",
      span: { start: 1, end: 50 },
      totalLines: 80,
      numbered: true,
      truncated: false,
    };
    tracker.recordRead(observed);
    expect(tracker.checkReadRepeat(observed).count).toBe(1);
    tracker.recordRead(observed);
    // A failed edit of the same file: the next identical read starts over.
    tracker.recordCall("os.fs.edit", editOf("service.py", 0).args);
    tracker.recordOutcome("os.fs.edit", editOf("service.py", 0).args, notFound());
    expect(tracker.checkReadRepeat(observed).count).toBe(1);
    tracker.recordRead(observed);
    // ...and a second one with nothing attempted in between is caught.
    expect(tracker.checkReadRepeat(observed).count).toBe(2);
  });
});
