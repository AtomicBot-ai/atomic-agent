import { describe, it, expect } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  BATCH_LOOP_LABEL,
  LOOP_VETO_DENIED_REASON,
  ToolLoopTracker,
  formatForcedGrammarReply,
  formatForcedLoopReply,
  formatRepeatNotice,
  formatVetoInstruction,
  formatWanderingRedirect,
  hashToolOutcome,
  isLoopVetoResult,
  isWanderingProneTool,
} from "./loop-detector.js";

function mkResult(
  overrides: Partial<CompressedToolResult> = {},
): CompressedToolResult {
  return {
    tool: "t",
    status: "ok",
    summary: "ok",
    details: {},
    truncated: false,
    ...overrides,
  };
}

/** Record a full call cycle: check (discarded) → recordCall → recordOutcome. */
function cycle(
  tracker: ToolLoopTracker,
  tool: string,
  args: unknown,
  result: CompressedToolResult,
): void {
  tracker.check(tool, args);
  tracker.recordCall(tool, args);
  tracker.recordOutcome(tool, args, result);
}

describe("ToolLoopTracker.check", () => {
  it("returns ok for a fresh signature", () => {
    const tracker = new ToolLoopTracker();
    expect(tracker.check("browser.click", { ref: "e1" }).level).toBe("ok");
  });

  it("escalates from ok → warn → critical on identical args+result", () => {
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 3,
    });
    const args = { ref: "e1" };
    const result = mkResult({ summary: "clicked e1" });

    // 1st completed
    expect(tracker.check("browser.click", args).level).toBe("ok");
    tracker.recordCall("browser.click", args);
    tracker.recordOutcome("browser.click", args, result);
    // 2nd completed
    expect(tracker.check("browser.click", args).level).toBe("ok");
    tracker.recordCall("browser.click", args);
    tracker.recordOutcome("browser.click", args, result);
    // 3rd: repeatCount hit 2 → warn
    const warn = tracker.check("browser.click", args);
    expect(warn.level).toBe("warn");
    expect(warn.detector).toBe("generic_repeat");
    tracker.recordCall("browser.click", args);
    tracker.recordOutcome("browser.click", args, result);
    // 4th: no-progress streak hit 3 → critical
    const critical = tracker.check("browser.click", args);
    expect(critical.level).toBe("critical");
    expect(critical.detector).toBe("no_progress");
    expect(critical.count).toBe(3);
  });

  it("tolerates interleaving when counting the no-progress streak", () => {
    const tracker = new ToolLoopTracker({ criticalThreshold: 3 });
    const a = { path: "a" };
    const b = { path: "b" };
    const ra = mkResult({ summary: "ra" });
    const rb = mkResult({ summary: "rb" });
    // A,B,A,B,A interleaved — A keeps producing the same result
    cycle(tracker, "os.fs.read", a, ra);
    cycle(tracker, "os.fs.read", b, rb);
    cycle(tracker, "os.fs.read", a, ra);
    cycle(tracker, "os.fs.read", b, rb);
    cycle(tracker, "os.fs.read", a, ra);
    expect(tracker.check("os.fs.read", a).level).toBe("critical");
  });

  it("breaks the streak when the result changes (result-aware)", () => {
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 3,
    });
    const args = { q: "x" };
    cycle(tracker, "os.web.fetch", args, mkResult({ summary: "r1" }));
    cycle(tracker, "os.web.fetch", args, mkResult({ summary: "r1" }));
    cycle(tracker, "os.web.fetch", args, mkResult({ summary: "r2-changed" }));
    // Result changed → no-progress streak is 1, but args repeated 3× → warn
    const verdict = tracker.check("os.web.fetch", args);
    expect(verdict.level).toBe("warn");
  });

  it("treats reordered object keys as the same signature", () => {
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 99,
    });
    const r = mkResult();
    cycle(tracker, "t", { a: 1, b: 2 }, r);
    cycle(tracker, "t", { b: 2, a: 1 }, r);
    expect(tracker.check("t", { a: 1, b: 2 }).level).toBe("warn");
  });
});

describe("ToolLoopTracker veto exclusion and breaker", () => {
  it("plateaus the streak at criticalThreshold once vetoes start", () => {
    const tracker = new ToolLoopTracker({ criticalThreshold: 3 });
    const args = { ref: "e1" };
    const result = mkResult({ summary: "same" });
    for (let i = 0; i < 3; i += 1) cycle(tracker, "browser.click", args, result);

    const first = tracker.check("browser.click", args);
    expect(first.level).toBe("critical");
    expect(first.count).toBe(3);
    // simulate the gate vetoing: recordCall + veto outcome
    const veto = mkResult({
      status: "error",
      details: { deniedReason: LOOP_VETO_DENIED_REASON },
    });
    tracker.recordCall("browser.click", args);
    tracker.recordOutcome("browser.click", args, veto);

    // streak stays 3 (the vetoed entry is excluded), never climbs to 4
    const second = tracker.check("browser.click", args);
    expect(second.level).toBe("critical");
    expect(second.count).toBe(3);
  });

  it("trips the breaker after breakerVetoStreak consecutive vetoes", () => {
    const tracker = new ToolLoopTracker({
      criticalThreshold: 3,
      breakerVetoStreak: 2,
    });
    const args = { ref: "e1" };
    const result = mkResult({ summary: "same" });
    for (let i = 0; i < 3; i += 1) cycle(tracker, "browser.click", args, result);
    const veto = mkResult({
      status: "error",
      details: { deniedReason: LOOP_VETO_DENIED_REASON },
    });

    expect(tracker.isBreakerTripped("browser.click", args)).toBe(false);
    tracker.recordCall("browser.click", args);
    tracker.recordOutcome("browser.click", args, veto); // veto #1
    expect(tracker.isBreakerTripped("browser.click", args)).toBe(false);
    tracker.recordCall("browser.click", args);
    tracker.recordOutcome("browser.click", args, veto); // veto #2
    expect(tracker.isBreakerTripped("browser.click", args)).toBe(true);
  });

  it("resets the veto streak when a real outcome of a different call lands", () => {
    const tracker = new ToolLoopTracker({ breakerVetoStreak: 2 });
    const args = { ref: "e1" };
    const veto = mkResult({
      status: "error",
      details: { deniedReason: LOOP_VETO_DENIED_REASON },
    });
    tracker.noteVeto("browser.click", args);
    tracker.noteVeto("browser.click", args);
    expect(tracker.isBreakerTripped("browser.click", args)).toBe(true);
    // a different call producing a real outcome clears the veto signature
    cycle(tracker, "os.fs.read", { path: "x" }, mkResult({ summary: "y" }));
    expect(tracker.isBreakerTripped("browser.click", args)).toBe(false);
    void veto;
  });
});

describe("ToolLoopTracker.shouldEmitWarning", () => {
  it("emits once per bucket of warningBucketSize repeats", () => {
    const tracker = new ToolLoopTracker({
      warningThreshold: 3,
      warningBucketSize: 5,
    });
    const key = "warn:t:h";
    expect(tracker.shouldEmitWarning(key, 3)).toBe(true); // bucket 0
    expect(tracker.shouldEmitWarning(key, 4)).toBe(false); // still bucket 0
    expect(tracker.shouldEmitWarning(key, 7)).toBe(false); // still bucket 0
    expect(tracker.shouldEmitWarning(key, 8)).toBe(true); // bucket 1
  });

  it("never emits below the warning threshold", () => {
    const tracker = new ToolLoopTracker({ warningThreshold: 3 });
    expect(tracker.shouldEmitWarning("warn:t:h", 2)).toBe(false);
  });
});

describe("ToolLoopTracker.observeBatchComposite", () => {
  const calls = [
    { tool: "os.fs.read", args: { path: "a" } },
    { tool: "os.fs.read", args: { path: "b" } },
  ];
  const results = [mkResult({ summary: "ok-a" }), mkResult({ summary: "ok-b" })];

  it("flags an identical batch repeated enough times", () => {
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 9,
    });
    expect(tracker.observeBatchComposite(calls, results).level).toBe("ok");
    expect(tracker.observeBatchComposite(calls, results).level).toBe("ok");
    const v = tracker.observeBatchComposite(calls, results);
    expect(v.level).toBe("warn");
    expect(v.tool).toBe(BATCH_LOOP_LABEL);
  });

  it("does not flag a permuted batch as a repeat", () => {
    const tracker = new ToolLoopTracker({ warningThreshold: 2 });
    const permuted = [calls[1]!, calls[0]!];
    const permutedResults = [results[1]!, results[0]!];
    expect(tracker.observeBatchComposite(calls, results).level).toBe("ok");
    expect(
      tracker.observeBatchComposite(permuted, permutedResults).level,
    ).toBe("ok");
    expect(tracker.observeBatchComposite(calls, results).level).toBe("ok");
  });
});

describe("hashToolOutcome / isLoopVetoResult", () => {
  it("returns undefined for a loop-veto result and detects it", () => {
    const veto = mkResult({
      status: "error",
      details: { deniedReason: LOOP_VETO_DENIED_REASON },
    });
    expect(isLoopVetoResult(veto)).toBe(true);
    expect(hashToolOutcome("t", {}, veto)).toBeUndefined();
  });

  it("collapses errors to a stable error hash regardless of detail noise", () => {
    const a = hashToolOutcome(
      "t",
      {},
      mkResult({ status: "error", summary: "boom", details: { x: 1 } }),
    );
    const b = hashToolOutcome(
      "t",
      {},
      mkResult({ status: "error", summary: "boom", details: { x: 2 } }),
    );
    expect(a).toBe(b);
    expect(a?.startsWith("error:")).toBe(true);
  });

  it("normalises os.shell.run by exit code + summary", () => {
    const ok0 = hashToolOutcome(
      "os.shell.run",
      {},
      mkResult({ summary: "done", details: { exitCode: 0 } }),
    );
    const ok0Again = hashToolOutcome(
      "os.shell.run",
      {},
      mkResult({ summary: "done", details: { exitCode: 0, extra: "noise" } }),
    );
    const fail1 = hashToolOutcome(
      "os.shell.run",
      {},
      mkResult({ summary: "done", details: { exitCode: 1 } }),
    );
    expect(ok0).toBe(ok0Again);
    expect(ok0).not.toBe(fail1);
  });
});

describe("loop notice formatters", () => {
  it("formatRepeatNotice mentions tool name and count", () => {
    const notice = formatRepeatNotice({ tool: "browser.click", count: 5 });
    expect(notice).toContain("browser.click");
    expect(notice).toContain("5 times");
  });

  it("formatVetoInstruction tells the model not to repeat", () => {
    const veto = formatVetoInstruction({ tool: "os.web.fetch", count: 5 });
    expect(veto).toContain("BLOCKED");
    expect(veto).toContain("os.web.fetch");
    expect(veto.toLowerCase()).toContain("do not repeat");
  });

  it("is class-aware for web vs browser tools", () => {
    expect(formatRepeatNotice({ tool: "os.http.request", count: 3 })).toContain(
      "HTTP error",
    );
    expect(formatRepeatNotice({ tool: "browser.click", count: 3 })).toContain(
      "### world",
    );
  });

  it("formatForcedLoopReply explains the graceful stop", () => {
    const reply = formatForcedLoopReply("browser.click", 4);
    expect(reply).toContain("browser.click");
    expect(reply).toContain("4");
    expect(reply.toLowerCase()).toContain("best answer");
  });

  it("formatForcedGrammarReply keeps the reason short and actionable", () => {
    const reply = formatForcedGrammarReply(
      "tool-call JSON value is incomplete",
    );
    expect(reply).toContain("tool-call JSON value is incomplete");
    expect(reply.toLowerCase()).toContain("not a valid tool call");
    expect(reply.toLowerCase()).toContain("stronger model");
  });

  it("formatWanderingRedirect is an actionable redirect", () => {
    const note = formatWanderingRedirect("os.web.fetch", 7);
    expect(note).toContain("os.web.fetch");
    expect(note).toContain("7 different arguments");
    expect(note.toLowerCase()).toContain("wandering loop");
    expect(note.toLowerCase()).toContain("search");
  });
});

describe("ToolLoopTracker wandering detector", () => {
  it("flags a wandering loop on distinct web fetches", () => {
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 3,
      wanderingEscalation: 9,
    });
    cycle(tracker, "os.web.fetch", { url: "u1" }, mkResult({ summary: "r1" }));
    cycle(tracker, "os.web.fetch", { url: "u2" }, mkResult({ summary: "r2" }));
    const verdict = tracker.check("os.web.fetch", { url: "u3" });
    expect(verdict.level).toBe("warn");
    expect(verdict.detector).toBe("wandering");
    expect(verdict.count).toBe(3);
    expect(verdict.warningKey).toBe("wandering:os.web.fetch");
  });

  it("does not flag wandering for distinct file reads", () => {
    const tracker = new ToolLoopTracker({ wanderingThreshold: 3 });
    cycle(tracker, "os.fs.read", { path: "a" }, mkResult({ summary: "ra" }));
    cycle(tracker, "os.fs.read", { path: "b" }, mkResult({ summary: "rb" }));
    const verdict = tracker.check("os.fs.read", { path: "c" });
    expect(verdict.detector).not.toBe("wandering");
    expect(verdict.level).toBe("ok");
  });

  it("escalates a wandering loop once the spread crosses the ceiling", () => {
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 3,
      wanderingEscalation: 4,
    });
    cycle(tracker, "os.http.request", { url: "u1" }, mkResult({ summary: "r1" }));
    cycle(tracker, "os.http.request", { url: "u2" }, mkResult({ summary: "r2" }));
    cycle(tracker, "os.http.request", { url: "u3" }, mkResult({ summary: "r3" }));
    // A new (4th) distinct signature crosses the escalation spread of 4.
    expect(
      tracker.isWanderingEscalated("os.http.request", { url: "u4" }),
    ).toBe(true);
    // An already-seen signature keeps the spread at 3 (no escalation).
    expect(
      tracker.isWanderingEscalated("os.http.request", { url: "u3" }),
    ).toBe(false);
    // Non-wandering tools never escalate on spread.
    expect(tracker.isWanderingEscalated("os.fs.read", { path: "z" })).toBe(false);
  });

  it("flags a wandering loop on distinct web searches (query spam)", () => {
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 3,
      wanderingEscalation: 9,
    });
    cycle(tracker, "os.web.search", { query: "q1" }, mkResult({ summary: "r1" }));
    cycle(tracker, "os.web.search", { query: "q2" }, mkResult({ summary: "r2" }));
    const verdict = tracker.check("os.web.search", { query: "q3" });
    expect(verdict.level).toBe("warn");
    expect(verdict.detector).toBe("wandering");
    expect(verdict.count).toBe(3);
    expect(verdict.warningKey).toBe("wandering:os.web.search");
  });

  it("isWanderingProneTool covers web search / fetch / http / browser only", () => {
    expect(isWanderingProneTool("os.web.fetch")).toBe(true);
    expect(isWanderingProneTool("os.web.search")).toBe(true);
    expect(isWanderingProneTool("os.http.request")).toBe(true);
    expect(isWanderingProneTool("browser.click")).toBe(true);
    expect(isWanderingProneTool("os.fs.read")).toBe(false);
    expect(isWanderingProneTool("memory.notes.recall")).toBe(false);
  });
});

describe("hashToolOutcome volatile stripping", () => {
  it("collapses identical responses that differ only in volatile fields", () => {
    const a = mkResult({
      tool: "os.http.request",
      summary: "body",
      details: { url: "u", status: 200, timeTotalSeconds: 0.11, sizeDownload: 1234 },
    });
    const b = mkResult({
      tool: "os.http.request",
      summary: "body",
      details: { url: "u", status: 200, timeTotalSeconds: 0.93, sizeDownload: 1240 },
    });
    expect(hashToolOutcome("os.http.request", {}, a)).toBe(
      hashToolOutcome("os.http.request", {}, b),
    );
  });

  it("still distinguishes responses that differ in stable fields", () => {
    const a = mkResult({
      summary: "body",
      details: { status: 200, timeTotalSeconds: 0.1 },
    });
    const b = mkResult({
      summary: "body",
      details: { status: 404, timeTotalSeconds: 0.1 },
    });
    expect(hashToolOutcome("t", {}, a)).not.toBe(hashToolOutcome("t", {}, b));
  });

  it("strips volatile keys nested in arrays and objects", () => {
    const a = mkResult({
      summary: "body",
      details: { items: [{ id: 1, name: "x" }], meta: { requestId: "abc" } },
    });
    const b = mkResult({
      summary: "body",
      details: { items: [{ id: 2, name: "x" }], meta: { requestId: "zzz" } },
    });
    expect(hashToolOutcome("t", {}, a)).toBe(hashToolOutcome("t", {}, b));
  });
});
