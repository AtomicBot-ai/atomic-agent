import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/tracing/trace/trace-event.js";

import {
  analyzeTrace,
  parseTraceNdjson,
  renderPostmortem,
} from "./postmortem-trace.js";

const sessionId = "sess-1";
const ts = 1_700_000_000_000;

const turnStarted = (turnIndex: number, seq: number): TraceEvent => ({
  type: "turn_started",
  seq,
  sessionId,
  ts,
  turnIndex,
  userMessage: `user msg ${turnIndex}`,
});

const turnFinished = (
  turnIndex: number,
  seq: number,
  reason: "reply" | "finish" | "failed" | "cancelled" | "max_steps" | "stalled",
  stepCount = 1,
  durationMs = 1000,
): TraceEvent => ({
  type: "turn_finished",
  seq,
  sessionId,
  ts,
  turnIndex,
  reason,
  stepCount,
  durationMs,
});

const promptCaptured = (
  turnIndex: number,
  seq: number,
  stepIndex: number,
  total: number,
): TraceEvent => ({
  type: "prompt_captured",
  seq,
  sessionId,
  ts,
  turnIndex,
  stepIndex,
  stablePrefixHash: "abc",
  tail: "",
  tokens: { total, stablePrefix: total - 100, tail: 100 },
  slotId: 0,
  cacheReused: false,
});

const errorEvent = (
  turnIndex: number,
  seq: number,
  message: string,
  category: "transport" | "grammar" | "model" | "tool" | "cancelled" | undefined,
): TraceEvent => ({
  type: "error",
  seq,
  sessionId,
  ts,
  turnIndex,
  message,
  category,
});

describe("analyzeTrace", () => {
  it("produces empty report for empty input", () => {
    const r = analyzeTrace([]);
    expect(r.totalTurns).toBe(0);
    expect(r.sessionId).toBeNull();
    expect(r.reasonHistogram).toEqual({});
    expect(r.problemTurns).toEqual([]);
  });

  it("rolls up reply / failed / max_steps mix", () => {
    const events: TraceEvent[] = [
      { type: "session_started", seq: 0, sessionId, ts, workingDir: "/" },
      turnStarted(0, 1),
      promptCaptured(0, 2, 0, 1000),
      turnFinished(0, 3, "reply", 1, 500),
      turnStarted(1, 4),
      promptCaptured(1, 5, 0, 12000),
      promptCaptured(1, 6, 1, 15000),
      turnFinished(1, 7, "max_steps", 16, 60000),
      turnStarted(2, 8),
      errorEvent(2, 9, "ggml fail", "transport"),
      errorEvent(2, 10, "model truncated", "model"),
      turnFinished(2, 11, "failed", 3, 1200),
    ];
    const r = analyzeTrace(events);
    expect(r.sessionId).toBe(sessionId);
    expect(r.totalTurns).toBe(3);
    expect(r.reasonHistogram).toEqual({ reply: 1, max_steps: 1, failed: 1 });
    expect(r.problemTurns.length).toBe(2);

    const t1 = r.turns[1];
    expect(t1.turnIndex).toBe(1);
    expect(t1.maxPromptTokens).toBe(15000);
    expect(t1.totalPromptTokens).toBe(27000);
    expect(t1.stepCount).toBe(16);

    const t2 = r.turns[2];
    expect(t2.errorCount).toBe(2);
    expect(t2.lastErrors.map((e) => e.category)).toEqual(["transport", "model"]);
  });

  it("records turn as <no-finish> when turn_finished is missing", () => {
    const events: TraceEvent[] = [turnStarted(0, 0), turnStarted(1, 1)];
    const r = analyzeTrace(events);
    expect(r.reasonHistogram).toEqual({ "<no-finish>": 2 });
    expect(r.problemTurns).toHaveLength(2);
    expect(r.problemTurns.map((t) => t.reason)).toEqual([null, null]);
  });

  it("keeps only the last three errors per turn", () => {
    const events: TraceEvent[] = [
      turnStarted(0, 0),
      errorEvent(0, 1, "e1", "transport"),
      errorEvent(0, 2, "e2", "grammar"),
      errorEvent(0, 3, "e3", "model"),
      errorEvent(0, 4, "e4", "tool"),
      errorEvent(0, 5, "e5", "cancelled"),
      turnFinished(0, 6, "failed", 5, 1000),
    ];
    const r = analyzeTrace(events);
    expect(r.turns[0].errorCount).toBe(5);
    expect(r.turns[0].lastErrors.map((e) => e.message)).toEqual(["e3", "e4", "e5"]);
  });

  it("captures trace_truncated marker", () => {
    const events: TraceEvent[] = [
      turnStarted(0, 0),
      turnFinished(0, 1, "reply"),
      { type: "trace_truncated", seq: 2, sessionId, ts, reason: "size_cap" },
    ];
    const r = analyzeTrace(events);
    expect(r.traceTruncated).toEqual({ reason: "size_cap", atSeq: 2 });
  });

  it("treats finish as a non-problem terminal", () => {
    const events: TraceEvent[] = [
      turnStarted(0, 0),
      turnFinished(0, 1, "finish"),
      turnStarted(1, 2),
      turnFinished(1, 3, "cancelled"),
    ];
    const r = analyzeTrace(events);
    expect(r.problemTurns.map((t) => t.reason)).toEqual(["cancelled"]);
  });

  it("emits turns sorted by turnIndex even when events arrive out of order", () => {
    const events: TraceEvent[] = [
      turnStarted(2, 0),
      turnStarted(0, 1),
      turnStarted(1, 2),
      turnFinished(0, 3, "reply"),
      turnFinished(1, 4, "reply"),
      turnFinished(2, 5, "reply"),
    ];
    const r = analyzeTrace(events);
    expect(r.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
  });
});

describe("renderPostmortem", () => {
  it("includes reason histogram and problem turn table", () => {
    const events: TraceEvent[] = [
      turnStarted(0, 0),
      turnFinished(0, 1, "reply", 1, 500),
      turnStarted(1, 2),
      promptCaptured(1, 3, 0, 20000),
      turnFinished(1, 4, "max_steps", 16, 60000),
    ];
    const out = renderPostmortem(analyzeTrace(events));
    expect(out).toContain("# Trace postmortem");
    expect(out).toContain("| reply | 1 |");
    expect(out).toContain("| max_steps | 1 |");
    expect(out).toContain("Problem turns (reason ≠ reply / finish): 1");
    expect(out).toContain("| 1 | max_steps | 16 | 60000 | 20000 | 0 |");
  });

  it("notes when trace was truncated", () => {
    const events: TraceEvent[] = [
      turnStarted(0, 0),
      turnFinished(0, 1, "reply"),
      { type: "trace_truncated", seq: 2, sessionId, ts, reason: "cap" },
    ];
    const out = renderPostmortem(analyzeTrace(events));
    expect(out).toContain("Trace truncated at seq=2");
  });

  it("explicitly says (none) when no problem turns", () => {
    const events: TraceEvent[] = [
      turnStarted(0, 0),
      turnFinished(0, 1, "reply"),
    ];
    const out = renderPostmortem(analyzeTrace(events));
    expect(out).toContain("Problem turns (reason ≠ reply / finish): 0");
    expect(out).toContain("(none)");
  });
});

describe("parseTraceNdjson", () => {
  it("parses well-formed lines and skips malformed ones", () => {
    const raw =
      JSON.stringify({ type: "turn_started", seq: 0, sessionId, ts, turnIndex: 0 }) +
      "\n" +
      "not json garbage\n" +
      JSON.stringify({
        type: "turn_finished",
        seq: 1,
        sessionId,
        ts,
        turnIndex: 0,
        reason: "reply",
        stepCount: 1,
        durationMs: 100,
      }) +
      "\n";
    const skipped: string[] = [];
    const events = parseTraceNdjson(raw, (line) => skipped.push(line));
    expect(events).toHaveLength(2);
    expect(skipped).toEqual(["not json garbage"]);
  });

  it("tolerates trailing whitespace and blank lines", () => {
    const raw =
      "\n  \n" +
      JSON.stringify({ type: "turn_started", seq: 0, sessionId, ts, turnIndex: 0 }) +
      "\n";
    const events = parseTraceNdjson(raw);
    expect(events).toHaveLength(1);
  });
});
