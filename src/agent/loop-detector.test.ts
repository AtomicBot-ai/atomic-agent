import { describe, it, expect } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  BATCH_LOOP_LABEL,
  LOOP_VETO_DENIED_REASON,
  OUTCOME_REPEAT_WARNING_THRESHOLD,
  ToolLoopTracker,
  extractLoopTarget,
  fingerprintToolOutcome,
  formatForcedLoopReply,
  formatOutcomeRepeatNotice,
  formatRepeatNotice,
  formatTestRepeatNotice,
  formatVetoInstruction,
  formatWanderingRedirect,
  hashToolOutcome,
  isLoopVetoResult,
  isWanderingProneTool,
  WANDERING_CEILING_SHARE,
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
    for (let i = 0; i < 3; i += 1)
      cycle(tracker, "browser.click", args, result);

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
    for (let i = 0; i < 3; i += 1)
      cycle(tracker, "browser.click", args, result);
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
  const results = [
    mkResult({ summary: "ok-a" }),
    mkResult({ summary: "ok-b" }),
  ];

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
    expect(tracker.observeBatchComposite(permuted, permutedResults).level).toBe(
      "ok",
    );
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
    const reply = formatForcedLoopReply("browser.click", 4, undefined, 4);
    expect(reply).toContain("browser.click");
    expect(reply).toContain("4");
    expect(reply.toLowerCase()).toContain("best answer");
  });

  it("formatForcedLoopReply keeps the repeat wording for every non-wandering detector", () => {
    for (const detector of [
      undefined,
      "generic_repeat",
      "no_progress",
      "read_repeat",
      "outcome_repeat",
    ] as const) {
      const reply = formatForcedLoopReply("os.shell.run", 5, detector, 4);
      expect(reply).toContain("no-progress outcome");
      expect(reply).toContain("refused 4 times in a row");
      expect(reply).toContain("repeated tool call");
    }
  });

  // The streak is not the number of refusals: with the defaults the
  // no-progress streak plateaus at 5 while the breaker trips on the 4th
  // refusal, so "after 5 blocked attempts" overstated the refusals by
  // one on every ordinary repeat stop. This case passes 3 to show the
  // reply quotes what it is given, not the streak beside it.
  it("formatForcedLoopReply quotes the refusal count, not the streak, when it has one", () => {
    const reply = formatForcedLoopReply("os.shell.run", 5, "no_progress", 3);
    expect(reply).toContain("refused 3 times in a row, counting this one");
    expect(reply).not.toMatch(/blocked attempts/i);
    // The streak must not be quoted as a refusal count.
    expect(reply).not.toContain("5");
    expect(reply.toLowerCase()).toContain("best answer");
  });

  it("formatForcedLoopReply says `time` for a single refusal", () => {
    const reply = formatForcedLoopReply("os.shell.run", 5, "no_progress", 1);
    expect(reply).toContain("refused 1 time in a row");
    expect(reply).not.toContain("1 times");
  });

  // The 3-argument form is exported API (src/agent/index.ts) and has no
  // refusal count to quote. It must not fall back to `count`: on a
  // breaker signal that is `max(streak, breakerVetoStreak)`, so it is
  // not a streak this function can honestly describe. The production
  // caller never reaches this branch — a veto is recorded before the
  // signal is built, so `blocked` is always >= 1 there.
  it("formatForcedLoopReply quotes no number when it has no refusal count", () => {
    for (const reply of [
      formatForcedLoopReply("os.shell.run", 5, "no_progress"),
      formatForcedLoopReply("os.shell.run", 5, "no_progress", 0),
    ]) {
      expect(reply).toContain("kept returning the same no-progress outcome");
      expect(reply).toContain("this call was not run");
      expect(reply).not.toMatch(/blocked attempts|refused/i);
      expect(reply).not.toMatch(/\d/);
    }
  });

  // Issue #458: a wandering escalation ended a turn of 11 successful,
  // distinct fetches with "stuck in a no-progress loop … after 12 blocked
  // attempts" — only one call was blocked and nothing was repeated.
  it("formatForcedLoopReply words a wandering stop as a spread cap, not a repeat", () => {
    const reply = formatForcedLoopReply("os.web.fetch", 12, "wandering");
    expect(reply).toContain("`os.web.fetch`");
    expect(reply).toContain("hit the limit on different arguments");
    expect(reply).toContain("12, counting the last call, which was not run");
    expect(reply).not.toMatch(/this turn|single turn/i);
    expect(reply.toLowerCase()).toContain("best answer");
    expect(reply).not.toMatch(/no-progress/i);
    expect(reply).not.toMatch(/blocked attempts/i);
    expect(reply).not.toMatch(/repeated/i);
  });

  it("formatWanderingRedirect names a move a SEARCH tool can make (issue #458)", () => {
    const note = formatWanderingRedirect("os.web.search", 7);
    // The generic wording ("stop probing more URLs/pages") named no
    // action for a search tool -- it is what the reporter's model was
    // handed on the run that then hit the cap.
    expect(note).not.toContain("URLs/pages");
    expect(note).toContain("`os.web.fetch`");
    expect(note.toLowerCase()).toContain("already have search results");
    expect(note.toLowerCase()).toContain("wandering loop");
  });

  it("formatWanderingRedirect is an actionable redirect", () => {
    const note = formatWanderingRedirect("os.web.fetch", 7);
    expect(note).toContain("os.web.fetch");
    expect(note).toContain("7 different arguments");
    expect(note.toLowerCase()).toContain("wandering loop");
    expect(note.toLowerCase()).toContain("search");
  });
});

describe("extractLoopTarget", () => {
  it("reduces a web fetch URL to its host, dropping path and query", () => {
    expect(
      extractLoopTarget("os.web.fetch", {
        url: "https://web.archive.org/web/2020/https://x.test/a?token=SECRET",
      }),
    ).toBe("web.archive.org");
  });

  it("handles os.http.request and schemeless URLs", () => {
    expect(
      extractLoopTarget("os.http.request", {
        url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed",
      }),
    ).toBe("eutils.ncbi.nlm.nih.gov");
    expect(
      extractLoopTarget("os.web.fetch", { url: "en.wikipedia.org/wiki/X" }),
    ).toBe("en.wikipedia.org");
  });

  it("reduces a shell command to the executable name only", () => {
    expect(
      extractLoopTarget("os.shell.run", {
        command:
          "curl -s https://x.test/a --header 'Authorization: Bearer SECRET'",
      }),
    ).toBe("curl");
  });

  it("returns undefined for unextractable or malformed args", () => {
    expect(extractLoopTarget("os.web.fetch", {})).toBeUndefined();
    expect(extractLoopTarget("os.web.fetch", { url: "" })).toBeUndefined();
    expect(extractLoopTarget("os.web.fetch", { url: 42 })).toBeUndefined();
    expect(extractLoopTarget("os.web.fetch", null)).toBeUndefined();
    expect(extractLoopTarget("os.web.fetch", undefined)).toBeUndefined();
    expect(extractLoopTarget("os.web.fetch", "not-an-object")).toBeUndefined();
    expect(
      extractLoopTarget("os.shell.run", { command: "   " }),
    ).toBeUndefined();
    expect(
      extractLoopTarget("browser.click", { selector: "#a" }),
    ).toBeUndefined();
  });

  it("never throws on hostile or malformed URL values", () => {
    for (const url of ["http://", "://", "%%%", "h ttp://a b", " "]) {
      expect(() => extractLoopTarget("os.web.fetch", { url })).not.toThrow();
    }
  });
});

describe("veto message names the invariant and an alternative (issue #186)", () => {
  it("names the repeated host for a fetch loop", () => {
    const veto = formatVetoInstruction({
      tool: "os.web.fetch",
      count: 5,
      target: "web.archive.org",
      detector: "no_progress",
    });
    expect(veto).toContain("BLOCKED");
    expect(veto).toContain("web.archive.org");
    expect(veto).toContain("5 consecutive calls");
    expect(veto).toContain("same no-progress outcome");
  });

  it("offers the search-first alternative naming a different host", () => {
    const veto = formatVetoInstruction({
      tool: "os.web.fetch",
      count: 5,
      target: "web.archive.org",
      detector: "no_progress",
    });
    expect(veto).toContain("`os.web.search`");
    expect(veto).toContain("DIFFERENT host");
    expect(veto.toLowerCase()).toContain("do not repeat");
  });

  it("names the command for a shell loop", () => {
    const veto = formatVetoInstruction({
      tool: "os.shell.run",
      count: 5,
      target: "curl",
      detector: "no_progress",
    });
    expect(veto).toContain("`curl`");
    expect(veto).toContain("5 consecutive calls");
    expect(veto).toContain("change the arguments or path");
  });

  it("does not claim identical outcomes on a wandering escalation", () => {
    const veto = formatVetoInstruction({
      tool: "os.web.fetch",
      count: 13,
      target: "web.archive.org",
      detector: "wandering",
    });
    expect(veto).toContain("13 different attempts");
    expect(veto).toContain("web.archive.org");
    // Issue #458: 11 of the reported 12 attempts ran and returned usable
    // content, so "and still no answer" was a false statement about them.
    expect(veto).not.toContain("still no answer");
    expect(veto).toContain("without using what came back");
    expect(veto).not.toContain("identical");
    expect(veto).not.toContain("consecutive calls");
    // Wandering means many DIFFERENT URLs, so the hint says stop guessing
    // rather than "stop retrying" (which would imply identical calls).
    expect(veto).toContain("Stop guessing URLs");
    expect(veto).toContain("`os.web.search`");
    expect(veto).not.toContain("stop retrying");
  });

  it("degrades to the generic wording when no target can be extracted", () => {
    const veto = formatVetoInstruction({ tool: "noop", count: 5 });
    expect(veto).toContain("BLOCKED");
    expect(veto).toContain("`noop`");
    expect(veto).toContain(
      "5 consecutive calls returned the same no-progress outcome",
    );
    expect(veto).not.toContain("undefined");
    expect(veto.toLowerCase()).toContain("do not repeat");
  });

  it("sanitizes a hostile target: no backticks or newlines leak through", () => {
    const veto = formatVetoInstruction({
      tool: "os.web.fetch",
      count: 5,
      target: "evil`\n## injected heading\n`x",
      detector: "no_progress",
    });
    expect(veto).not.toContain("## injected heading\n");
    expect(veto.split("\n")[0]).toContain("evil");
    // Header stays a single line.
    expect(veto.split("\n")[0]).not.toContain("injected heading\n");
  });

  it("truncates an over-long target", () => {
    const veto = formatVetoInstruction({
      tool: "os.web.fetch",
      count: 5,
      target: "a".repeat(200),
      detector: "no_progress",
    });
    expect(veto).toContain("...");
    // The 200-char target is capped at 60 chars, not echoed in full.
    expect(veto).not.toContain("a".repeat(61));
    expect(veto.split("\n")[0]!.length).toBeLessThan(160);
  });

  it("stays short — the message is injected on every veto", () => {
    const veto = formatVetoInstruction({
      tool: "os.web.fetch",
      count: 5,
      target: "web.archive.org",
      detector: "no_progress",
    });
    expect(veto.split("\n").length).toBeLessThanOrEqual(5);
    expect(veto.length).toBeLessThan(600);
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
    cycle(
      tracker,
      "os.http.request",
      { url: "u1" },
      mkResult({ summary: "r1" }),
    );
    cycle(
      tracker,
      "os.http.request",
      { url: "u2" },
      mkResult({ summary: "r2" }),
    );
    cycle(
      tracker,
      "os.http.request",
      { url: "u3" },
      mkResult({ summary: "r3" }),
    );
    // A new (4th) distinct signature crosses the escalation spread of 4.
    expect(tracker.isWanderingEscalated("os.http.request", { url: "u4" })).toBe(
      true,
    );
    // An already-seen signature keeps the spread at 3 (no escalation).
    expect(tracker.isWanderingEscalated("os.http.request", { url: "u3" })).toBe(
      false,
    );
    // Non-wandering tools never escalate on spread.
    expect(tracker.isWanderingEscalated("os.fs.read", { path: "z" })).toBe(
      false,
    );
  });

  it("flags a wandering loop on distinct web searches (query spam)", () => {
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 3,
      wanderingEscalation: 9,
    });
    cycle(
      tracker,
      "os.web.search",
      { query: "q1" },
      mkResult({ summary: "r1" }),
    );
    cycle(
      tracker,
      "os.web.search",
      { query: "q2" },
      mkResult({ summary: "r2" }),
    );
    const verdict = tracker.check("os.web.search", { query: "q3" });
    expect(verdict.level).toBe("warn");
    expect(verdict.detector).toBe("wandering");
    expect(verdict.count).toBe(3);
    expect(verdict.warningKey).toBe("wandering:os.web.search");
  });

  // Issue #458, reported twice: a turn that IS making progress must not be
  // stopped. The spread the detector acts on is therefore scoped to the
  // current run -- distinct probes since another tool last succeeded --
  // and only the absolute ceiling still reads the whole window.
  it("does not escalate a research fan-out that keeps doing other work (issue #458)", () => {
    const tracker = new ToolLoopTracker();
    // The reported session, in order: nine distinct searches across three
    // batched steps, a failed CLI run, a successful one, then two more
    // searches. The twelfth search was the one that got blocked.
    const queries = [
      "avax news",
      "granite upgrade",
      "l1 growth",
      "tokenomics",
      "price analysis",
      "helicon upgrade",
      "q3 metrics",
      "firewood",
      "staking yield",
    ];
    for (const query of queries) {
      cycle(tracker, "os.web.search", { query }, mkResult({ summary: query }));
    }
    cycle(
      tracker,
      "os.shell.run",
      { cmd: "avalanche market" },
      mkResult({ status: "error", summary: "exit 2" }),
    );
    // A failed call is not progress -- the run is still open here.
    expect(tracker.wanderingSpread("os.web.search", { query: "fees" })).toBe(10);
    cycle(
      tracker,
      "os.shell.run",
      { cmd: "avalanche --compact market" },
      mkResult({ summary: "tvl 1.2B" }),
    );
    // ...and settled here, so the next searches start a fresh run.
    for (const query of ["fees", "etf inflows"]) {
      cycle(tracker, "os.web.search", { query }, mkResult({ summary: query }));
    }
    const twelfth = { query: "active l1 count" };
    expect(tracker.wanderingSpread("os.web.search", twelfth)).toBe(3);
    expect(tracker.isWanderingEscalated("os.web.search", twelfth)).toBe(false);
    // The window ladder still nudges -- twelve distinct queries are in
    // recent history -- but a nudge is a `### notice` the model can act
    // on, not the forced end of a turn. That is the whole complaint.
    const verdict = tracker.check("os.web.search", twelfth);
    expect(verdict.level).toBe("warn");
    expect(verdict.detector).toBe("wandering");
  });

  it("does not escalate 12 distinct fetches interleaved with successful reads (issue #458)", () => {
    const tracker = new ToolLoopTracker();
    for (let i = 0; i < 12; i += 1) {
      cycle(
        tracker,
        "os.web.fetch",
        { url: `https://example.test/file-${i}.ts` },
        mkResult({ summary: `contents ${i}` }),
      );
      cycle(
        tracker,
        "os.fs.grep",
        { pattern: `sym${i}` },
        mkResult({ summary: `hit ${i}` }),
      );
    }
    const next = { url: "https://example.test/file-12.ts" };
    expect(tracker.isWanderingEscalated("os.web.fetch", next)).toBe(false);
  });

  it("still escalates a probe run that never touches another tool", () => {
    const tracker = new ToolLoopTracker();
    for (let i = 0; i < 11; i += 1) {
      cycle(
        tracker,
        "os.web.search",
        { query: `q${i}` },
        mkResult({ summary: `serp ${i}` }),
      );
    }
    // Eleven recorded + this one = the default escalation spread of 12.
    expect(tracker.isWanderingEscalated("os.web.search", { query: "q11" })).toBe(
      true,
    );
  });

  it("escalates on the window ceiling even when the run keeps being settled", () => {
    // The bound the detector was built for: GAIA traces where a model
    // re-formulates ~35 queries while barely opening the pages it found.
    // Settling the run occasionally must not buy unlimited probing. Run
    // at STOCK thresholds -- the ceiling's production shape is 18 of a
    // 30-call window, a ratio a roomier test config would not exercise.
    const tracker = new ToolLoopTracker();
    const ceiling = Math.ceil(30 * WANDERING_CEILING_SHARE);
    let stop = tracker.wanderingStop("os.web.search", { query: "q0" });
    let probes = 0;
    while (!stop.escalated && probes < 40) {
      const args = { query: `q${probes}` };
      cycle(tracker, "os.web.search", args, mkResult({ summary: `serp ${probes}` }));
      probes += 1;
      // Four probes per settling call: the run never reaches 12, so only
      // the ceiling can stop this.
      if (probes % 4 === 0) {
        cycle(
          tracker,
          "os.fs.write",
          { path: `notes-${probes}.md` },
          mkResult({ summary: "written" }),
        );
      }
      stop = tracker.wanderingStop("os.web.search", { query: `q${probes}` });
    }
    expect(stop).toMatchObject({ escalated: true, rule: "ceiling" });
    expect(stop.spread).toBe(ceiling);
    // The run rule stayed quiet throughout -- this is the ceiling's doing.
    expect(probes).toBeGreaterThan(12);
  });

  it("words a ceiling stop as wandering, with its own spread", () => {
    // `check()` reads both ladders precisely so the gate cannot word a
    // ceiling stop off a `generic_repeat` verdict: that veto said
    // "repeated calls are not making progress", count 0, about calls that
    // were all distinct -- the statement this whole change removes.
    const tracker = new ToolLoopTracker();
    let stop = tracker.wanderingStop("os.web.search", { query: "q0" });
    let probes = 0;
    while (!stop.escalated && probes < 40) {
      const args = { query: `q${probes}` };
      cycle(tracker, "os.web.search", args, mkResult({ summary: `serp ${probes}` }));
      probes += 1;
      if (probes % 4 === 0) {
        cycle(tracker, "os.fs.grep", { pattern: `p${probes}` }, mkResult({ summary: "hit" }));
      }
      stop = tracker.wanderingStop("os.web.search", { query: `q${probes}` });
    }
    const verdict = tracker.check("os.web.search", { query: `q${probes}` });
    expect(verdict.detector).toBe("wandering");
    expect(verdict.count).toBe(stop.spread);
  });

  it("warns before it stops, at every ratio of probes to real work", () => {
    // A hard stop the model was never nudged about would make the
    // redirect notice -- and its `os.web.search` wording -- dead code in
    // exactly the shapes that need it.
    for (const perSettle of [2, 3, 4, 5, 6, 12]) {
      const tracker = new ToolLoopTracker();
      let warnedAt = -1;
      let stoppedAt = -1;
      for (let i = 0; i < 60; i += 1) {
        const args = { query: `q${i}` };
        if (tracker.wanderingStop("os.web.search", args).escalated) {
          stoppedAt = i;
          break;
        }
        const verdict = tracker.check("os.web.search", args);
        if (warnedAt < 0 && verdict.detector === "wandering") warnedAt = i;
        cycle(tracker, "os.web.search", args, mkResult({ summary: `serp ${i}` }));
        if ((i + 1) % perSettle === 0) {
          cycle(tracker, "os.shell.run", { cmd: `c${i}` }, mkResult({ summary: "done" }));
        }
      }
      expect(stoppedAt).toBeGreaterThan(0);
      expect(warnedAt).toBeGreaterThanOrEqual(0);
      expect(warnedAt).toBeLessThan(stoppedAt);
    }
  });

  it("keeps the ceiling reachable at every escalation setting", () => {
    // Derived from the ESCALATION, the ceiling died above esc 15: it then
    // needed a window of nothing but distinct probes, in which case the
    // run rule has already fired. Derived from the WINDOW, it is always
    // reachable, and the wandering knobs stop moving the ring buffer that
    // the unrelated repeat / no-progress detectors walk.
    for (const wanderingEscalation of [4, 12, 15, 20, 50]) {
      const tracker = new ToolLoopTracker({ wanderingEscalation });
      let fired = false;
      for (let i = 0; i < 200 && !fired; i += 1) {
        const args = { query: `q${i}` };
        const stop = tracker.wanderingStop("os.web.search", args);
        if (stop.escalated) {
          fired = stop.rule === "ceiling";
          break;
        }
        cycle(tracker, "os.web.search", args, mkResult({ summary: `serp ${i}` }));
        // Three probes per settling call: too few for the run rule at any
        // of these settings, so only the ceiling can fire.
        if ((i + 1) % 3 === 0) {
          cycle(tracker, "os.shell.run", { cmd: `c${i}` }, mkResult({ summary: "ok" }));
        }
      }
      expect({ wanderingEscalation, fired }).toEqual({
        wanderingEscalation,
        fired: true,
      });
    }
  });

  it("leaves the history ring to loopHistorySize alone", () => {
    // Deriving the ceiling from the escalation used to widen the ring,
    // and the ring is what `getNoProgressStreak` / `getRepeatCount` walk:
    // turning the wandering knob down in aggressiveness turned an
    // advisory on an unrelated tool into a veto.
    const verdicts = [4, 12, 20, 50].map((wanderingEscalation) => {
      const tracker = new ToolLoopTracker({ wanderingEscalation });
      const args = { path: "." };
      const result = mkResult({ summary: "same listing" });
      for (let i = 0; i < 4; i += 1) cycle(tracker, "os.fs.list", args, result);
      const verdict = tracker.check("os.fs.list", args);
      return `${verdict.level}/${verdict.detector}/${verdict.count}`;
    });
    expect(new Set(verdicts).size).toBe(1);
  });

  it("still bounds a browser loop that alternates two tools of one family", () => {
    // read_aria -> click -> read_aria is one probe in two moves. If they
    // settled each other the pair would be unbounded -- and "clicking
    // around" is what the browser redirect is written for.
    const tracker = new ToolLoopTracker();
    let stoppedAt = -1;
    for (let i = 0; i < 40; i += 1) {
      if (tracker.wanderingStop("browser.click", { sel: `#a${i}` }).escalated) {
        stoppedAt = i;
        break;
      }
      cycle(tracker, "browser.read_aria", { page: i }, mkResult({ summary: `aria ${i}` }));
      cycle(tracker, "browser.click", { sel: `#a${i}` }, mkResult({ summary: `clicked ${i}` }));
    }
    expect(stoppedAt).toBe(11);
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
      details: {
        url: "u",
        status: 200,
        timeTotalSeconds: 0.11,
        sizeDownload: 1234,
      },
    });
    const b = mkResult({
      tool: "os.http.request",
      summary: "body",
      details: {
        url: "u",
        status: 200,
        timeTotalSeconds: 0.93,
        sizeDownload: 1240,
      },
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

describe("test-repeat detector state (issue #118)", () => {
  const KEY = "/work/project pytest -k auth";

  it("does not flag the first run of a key", () => {
    const tracker = new ToolLoopTracker();
    expect(tracker.checkTestRepeat(KEY, "fp-1")).toEqual({
      repeat: false,
      count: 1,
    });
  });

  it("flags the second equivalent run and quotes the previous summary", () => {
    const tracker = new ToolLoopTracker();
    const args = { cmd: "pytest", args: ["-k", "auth"] };
    tracker.recordTestRun(KEY, "fp-1", "os.shell.run", args);
    tracker.recordOutcome(
      "os.shell.run",
      args,
      mkResult({ tool: "os.shell.run", summary: "3 passed in 1.2s" }),
    );
    const verdict = tracker.checkTestRepeat(KEY, "fp-1");
    expect(verdict.repeat).toBe(true);
    expect(verdict.count).toBe(2);
    expect(verdict.previousSummary).toBe("3 passed in 1.2s");
  });

  it("clears the repeat and drops the stored summary when the fingerprint changes", () => {
    const tracker = new ToolLoopTracker();
    const args = { cmd: "pytest", args: ["-k", "auth"] };
    tracker.recordTestRun(KEY, "fp-1", "os.shell.run", args);
    tracker.recordOutcome(
      "os.shell.run",
      args,
      mkResult({ tool: "os.shell.run", summary: "1 failed" }),
    );
    // Workspace changed: the rerun is permitted (no repeat) and the
    // pre-change summary must never be quoted against the new state.
    const changed = tracker.checkTestRepeat(KEY, "fp-2");
    expect(changed).toEqual({ repeat: false, count: 1 });
    tracker.recordTestRun(KEY, "fp-2", "os.shell.run", args);
    const next = tracker.checkTestRepeat(KEY, "fp-2");
    expect(next.repeat).toBe(true);
    expect(next.previousSummary).toBeUndefined();
  });

  it("keeps counting consecutive equivalent runs", () => {
    const tracker = new ToolLoopTracker();
    const args = { cmd: "pytest", args: [] };
    tracker.recordTestRun(KEY, "fp-1", "os.shell.run", args);
    tracker.recordTestRun(KEY, "fp-1", "os.shell.run", args);
    expect(tracker.checkTestRepeat(KEY, "fp-1").count).toBe(3);
  });

  it("keys are independent: another suite does not inherit the repeat", () => {
    const tracker = new ToolLoopTracker();
    const args = { cmd: "pytest", args: [] };
    tracker.recordTestRun(KEY, "fp-1", "os.shell.run", args);
    expect(tracker.checkTestRepeat("other-key", "fp-1").repeat).toBe(false);
  });

  it("shouldEmitWarning honours a per-detector minCount floor", () => {
    const tracker = new ToolLoopTracker();
    // Default floor (warningThreshold = 3) suppresses a count of 2 while
    // the test-repeat floor emits from the 2nd equivalent run.
    expect(tracker.shouldEmitWarning("warn:generic", 2)).toBe(false);
    expect(tracker.shouldEmitWarning("test_repeat:k", 2, 2)).toBe(true);
    // De-dup bucket: the same key stays silent within the bucket.
    expect(tracker.shouldEmitWarning("test_repeat:k", 3, 2)).toBe(false);
  });
});

describe("formatTestRepeatNotice", () => {
  it("names the command, quotes the previous result, and stays warn-only", () => {
    const text = formatTestRepeatNotice({
      count: 2,
      target: "pytest -k auth",
      previousSummary: "3 passed in 1.2s",
    });
    expect(text).toContain("`pytest -k auth`");
    expect(text).toContain("2 times");
    expect(text).toContain("Previous result: 3 passed in 1.2s");
    expect(text).toContain("nothing was blocked");
  });

  it("collapses and caps a long multi-line summary", () => {
    const text = formatTestRepeatNotice({
      count: 2,
      previousSummary: `line one\nline two\n${"x".repeat(500)}`,
    });
    expect(text).toContain("line one line two");
    expect(text).not.toContain("\nline two");
    const resultLine = text
      .split("\n")
      .find((l) => l.startsWith("Previous result:"))!;
    expect(resultLine.length).toBeLessThanOrEqual(320);
    expect(resultLine.endsWith("...")).toBe(true);
  });

  it("omits the previous-result line when no summary is known", () => {
    const text = formatTestRepeatNotice({ count: 2 });
    expect(text).toContain("the same test command");
    expect(text).not.toContain("Previous result:");
  });
});

describe("outcome-repeat detector (F25)", () => {
  /**
   * The argument-keyed detectors miss a model that re-checks with
   * slightly different arguments and gets the same answer every time —
   * run 04 spent six steps that way. This detector keys on the RESULT.
   */
  const same = mkResult({
    tool: "os.shell.run",
    status: "error",
    summary: "$ node --check game.js\nexit: 1\nSyntaxError: Unexpected token }",
  });

  it("warns on the third identical outcome, whatever the arguments were", () => {
    const tracker = new ToolLoopTracker();
    const verdicts = [1, 2, 3].map((n) => {
      const args = { cmd: "node", args: ["--check", `game${n}.js`] };
      tracker.check("os.shell.run", args);
      tracker.recordCall("os.shell.run", args);
      return tracker.recordOutcome("os.shell.run", args, same);
    });
    expect(verdicts.map((v) => v.count)).toEqual([1, 2, 3]);
    expect(verdicts.map((v) => v.repeat)).toEqual([false, false, true]);
    expect(OUTCOME_REPEAT_WARNING_THRESHOLD).toBe(3);
    expect(verdicts[2]!.fingerprint).toBe(
      fingerprintToolOutcome("os.shell.run", same),
    );
    // The argument-keyed detectors see three distinct signatures.
    expect(
      tracker.check("os.shell.run", { cmd: "node", args: ["--check", "x"] })
        .level,
    ).toBe("ok");
  });

  it("keeps a different status or summary apart", () => {
    const tracker = new ToolLoopTracker();
    const args = { path: "a" };
    cycle(tracker, "t", args, mkResult({ summary: "one" }));
    cycle(tracker, "t", args, mkResult({ summary: "one" }));
    expect(
      tracker.recordOutcome("t", args, mkResult({ summary: "two" })).repeat,
    ).toBe(false);
    expect(
      tracker.recordOutcome("t", args, mkResult({ summary: "one", status: "error" }))
        .repeat,
    ).toBe(false);
    expect(
      tracker.recordOutcome("t", args, mkResult({ summary: "one" })).repeat,
    ).toBe(true);
  });

  it("resets when a write, edit or patch succeeds — and not when one fails", () => {
    for (const write of ["os.fs.write", "os.fs.edit", "os.fs.patch"]) {
      const tracker = new ToolLoopTracker();
      cycle(tracker, "os.fs.list", { path: "." }, mkResult({ summary: "a b" }));
      cycle(tracker, "os.fs.list", { path: "./" }, mkResult({ summary: "a b" }));
      // A failed write changes nothing on disk: the count stands.
      const failed = tracker.recordOutcome(
        write,
        { path: "x" },
        mkResult({ tool: write, status: "error", summary: "EACCES" }),
      );
      expect(failed.repeat, write).toBe(false);
      expect(
        tracker.recordOutcome("os.fs.list", { path: "." }, mkResult({ summary: "a b" }))
          .count,
        write,
      ).toBe(3);
      // A successful one is the progress the repeats were waiting for.
      const landed = tracker.recordOutcome(
        write,
        { path: "x" },
        mkResult({ tool: write, status: "ok", summary: "wrote x" }),
      );
      expect(landed.repeat, write).toBe(false);
      expect(landed.count, write).toBe(0);
      expect(
        tracker.recordOutcome("os.fs.list", { path: "." }, mkResult({ summary: "a b" }))
          .count,
        write,
      ).toBe(1);
    }
  });

  it("does not count a loop veto as an outcome", () => {
    const tracker = new ToolLoopTracker();
    const veto = mkResult({
      status: "error",
      summary: "vetoed",
      details: { deniedReason: LOOP_VETO_DENIED_REASON },
    });
    for (let i = 0; i < 4; i += 1) {
      expect(tracker.recordOutcome("t", { i }, veto)).toEqual({
        repeat: false,
        count: 0,
        fingerprint: "",
      });
    }
  });

  it("fingerprints the tool, the status and a whitespace-collapsed 200-char head", () => {
    const long = mkResult({
      status: "ok",
      summary: `  a\n\n  b\t c ${"x".repeat(400)}`,
    });
    const fp = fingerprintToolOutcome("os.fs.grep", long);
    expect(fp.startsWith("os.fs.grep|ok|a b c x")).toBe(true);
    expect(fp.length).toBe("os.fs.grep|ok|".length + 200);
    expect(fingerprintToolOutcome("os.fs.glob", long)).not.toBe(fp);
    // Whitespace differences alone do not make a new outcome.
    expect(
      fingerprintToolOutcome("t", mkResult({ summary: "a  b\nc" })),
    ).toBe(fingerprintToolOutcome("t", mkResult({ summary: "a b c" })));
  });

  it("formats a warn-only notice that names the tool and asks for a change or a write", () => {
    const text = formatOutcomeRepeatNotice({ tool: "os.shell.run", count: 3 });
    expect(text).toContain("Same result three times from `os.shell.run`");
    expect(text).toContain("change approach or write");
    expect(text).toContain("nothing was blocked");
    expect(formatOutcomeRepeatNotice({ tool: "os.fs.glob", count: 5 })).toContain(
      "Same result 5 times",
    );
  });
});
