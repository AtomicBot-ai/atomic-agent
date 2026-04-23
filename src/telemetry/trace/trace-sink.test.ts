import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNdjsonTraceSink, traceFilePath } from "./trace-sink.js";
import type { TraceEvent } from "./trace-event.js";

function baseEvent(
  sessionId: string,
  seq: number,
  ts: number,
): TraceEvent {
  return {
    type: "step_started",
    sessionId,
    seq,
    ts,
    turnIndex: 0,
    stepIndex: seq,
  };
}

describe("createNdjsonTraceSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-trace-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one NDJSON line per event in session file", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 1024 });
    sink(baseEvent("s-1", 0, 100));
    sink(baseEvent("s-1", 1, 200));
    const path = traceFilePath(dir, "s-1");
    const raw = readFileSync(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 0, ts: 100 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 1, ts: 200 });
  });

  it("isolates different sessions into different files", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 1024 });
    sink(baseEvent("s-a", 0, 1));
    sink(baseEvent("s-b", 0, 2));
    const a = readFileSync(traceFilePath(dir, "s-a"), "utf8");
    const b = readFileSync(traceFilePath(dir, "s-b"), "utf8");
    expect(JSON.parse(a.trim())).toMatchObject({ sessionId: "s-a" });
    expect(JSON.parse(b.trim())).toMatchObject({ sessionId: "s-b" });
  });

  it("stops writing after maxBytesPerSession and emits trace_truncated marker", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 120 });
    sink(baseEvent("s-cap", 0, 1));
    sink(baseEvent("s-cap", 1, 2));
    sink(baseEvent("s-cap", 2, 3));
    sink(baseEvent("s-cap", 3, 4));
    const raw = readFileSync(traceFilePath(dir, "s-cap"), "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    expect(last.type).toBe("trace_truncated");
    expect(last.reason).toMatch(/maxBytesPerSession=120/);
  });

  it("ignores subsequent events once truncated", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 120 });
    sink(baseEvent("s-cap2", 0, 1));
    sink(baseEvent("s-cap2", 1, 2));
    sink(baseEvent("s-cap2", 2, 3));
    const before = readFileSync(traceFilePath(dir, "s-cap2"), "utf8")
      .trim()
      .split("\n").length;
    for (let i = 3; i < 10; i++) sink(baseEvent("s-cap2", i, i));
    const after = readFileSync(traceFilePath(dir, "s-cap2"), "utf8")
      .trim()
      .split("\n").length;
    expect(after).toBe(before);
  });
});
