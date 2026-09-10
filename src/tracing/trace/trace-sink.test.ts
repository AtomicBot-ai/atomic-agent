import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNdjsonTraceSink, traceFilePath } from "./trace-sink.js";
import type { TraceEvent } from "./trace-event.js";

function baseEvent(sessionId: string, seq: number, ts: number): TraceEvent {
  return {
    type: "step_started",
    sessionId,
    seq,
    ts,
    turnIndex: 0,
    stepIndex: seq,
  };
}

/** A `step_finished` padded to a known size so caps are predictable. */
function paddedEvent(sessionId: string, seq: number, pad: number): TraceEvent {
  return {
    type: "step_finished",
    sessionId,
    seq,
    ts: seq,
    turnIndex: 0,
    stepIndex: seq,
    summary: "x".repeat(pad),
    durationMs: seq,
  };
}

function readLines(dir: string, sessionId: string): Record<string, unknown>[] {
  return readFileSync(traceFilePath(dir, sessionId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  it("trims the head at the cap instead of going mute", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    for (let i = 0; i < 40; i++) sink(paddedEvent("s-cap", i, 40));

    const lines = readLines(dir, "s-cap");
    // The tail is what a postmortem needs, so the tail is what survives.
    expect(lines[lines.length - 1]).toMatchObject({ seq: 39 });
    // ...and the head is gone: only the marker stands where it was.
    expect(lines.some((l) => l.seq === 0 && l.type === "step_finished")).toBe(
      false,
    );
    expect(lines[0]).toMatchObject({ type: "trace_truncated" });
  });

  it("keeps the file under the cap while it keeps writing", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    for (let i = 0; i < 40; i++) {
      sink(paddedEvent("s-size", i, 40));
      const size = readFileSync(traceFilePath(dir, "s-size"), "utf8").length;
      expect(size).toBeLessThanOrEqual(600);
    }
  });

  it("states the loss in the marker and keeps it growing across trims", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    for (let i = 0; i < 8; i++) sink(paddedEvent("s-mark", i, 40));
    const first = readLines(dir, "s-mark").find(
      (l) => l.type === "trace_truncated",
    );
    expect(first).toBeDefined();
    expect(first!.droppedEvents).toBeGreaterThan(0);
    expect(first!.droppedBytes).toBeGreaterThan(0);
    expect(first!.reason).toMatch(/maxBytesPerSession=600/);

    for (let i = 8; i < 60; i++) sink(paddedEvent("s-mark", i, 40));
    const lines = readLines(dir, "s-mark");
    const markers = lines.filter((l) => l.type === "trace_truncated");
    // Exactly one tombstone survives, and it accounts for every event
    // lost so far — not just the ones the latest trim took.
    expect(markers).toHaveLength(1);
    expect(markers[0]!.droppedEvents).toBeGreaterThan(
      first!.droppedEvents as number,
    );
    // Nothing is invented: what was dropped plus what is still on disk
    // is every event that was ever handed to the sink.
    const kept = lines.filter((l) => l.type === "step_finished").length;
    expect(kept + (markers[0]!.droppedEvents as number)).toBe(60);
  });

  it("keeps the trimmed file parseable line by line and in order", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    for (let i = 0; i < 50; i++) sink(paddedEvent("s-parse", i, 40));
    const lines = readLines(dir, "s-parse");
    expect(lines.length).toBeGreaterThan(1);
    let previous = -1;
    for (const line of lines) {
      expect(typeof line.type).toBe("string");
      expect(line.seq as number).toBeGreaterThanOrEqual(previous);
      previous = line.seq as number;
    }
  });

  it("preserves session_started so trace list/replay still find the header", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    sink({
      type: "session_started",
      sessionId: "s-head",
      seq: 0,
      ts: 1,
      workingDir: "/tmp/project",
    });
    for (let i = 1; i < 50; i++) sink(paddedEvent("s-head", i, 40));
    const lines = readLines(dir, "s-head");
    expect(lines[0]).toMatchObject({
      type: "session_started",
      workingDir: "/tmp/project",
    });
    expect(lines[1]).toMatchObject({ type: "trace_truncated" });
    expect(lines[lines.length - 1]).toMatchObject({ seq: 49 });
  });

  it("resumes writing into a file that is already over the cap", () => {
    // Simulates a restart onto a trace an older build left at the cap:
    // `overflown` used to be re-derived from the file size and the
    // session stayed mute for good.
    const path = traceFilePath(dir, "s-resume");
    const stale = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify(paddedEvent("s-resume", i, 40)),
    ).join("\n");
    writeFileSync(path, `${stale}\n`, "utf8");
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(600);

    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    sink(paddedEvent("s-resume", 30, 40));
    const lines = readLines(dir, "s-resume");
    expect(lines[lines.length - 1]).toMatchObject({ seq: 30 });
    expect(lines.some((l) => l.type === "trace_truncated")).toBe(true);
  });

  it("does not throw when the trim cannot be written", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    for (let i = 0; i < 8; i++) sink(paddedEvent("s-ro", i, 40));
    const before = readFileSync(traceFilePath(dir, "s-ro"), "utf8");
    // A read-only directory fails the temp write; the sink must
    // degrade to "stop writing", never lose the file and never throw.
    chmodSync(dir, 0o500);
    try {
      expect(() => {
        for (let i = 8; i < 40; i++) sink(paddedEvent("s-ro", i, 40));
      }).not.toThrow();
      const after = readFileSync(traceFilePath(dir, "s-ro"), "utf8");
      // Nothing already recorded was lost or mangled — the failed
      // rewrite never touched the original — and the sink then went
      // quiet instead of retrying the trim on every later event.
      expect(after.startsWith(before)).toBe(true);
      expect(after.length).toBeLessThanOrEqual(600);
      for (const line of after.trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      sink(paddedEvent("s-ro", 40, 40));
      expect(readFileSync(traceFilePath(dir, "s-ro"), "utf8")).toBe(after);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("writes byte-identical output when the cap is never reached", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 1_000_000 });
    const events = Array.from({ length: 20 }, (_, i) =>
      paddedEvent("s-plain", i, 10),
    );
    for (const event of events) sink(event);
    const expected = events.map((e) => `${JSON.stringify(e)}\n`).join("");
    expect(readFileSync(traceFilePath(dir, "s-plain"), "utf8")).toBe(expected);
  });

  it("drops a single event larger than the cap without rewriting", () => {
    const sink = createNdjsonTraceSink({ dir, maxBytesPerSession: 600 });
    for (let i = 0; i < 8; i++) sink(paddedEvent("s-big", i, 40));
    const before = readFileSync(traceFilePath(dir, "s-big"), "utf8");
    sink(paddedEvent("s-big", 99, 5000));
    // The giant row cannot be stored under any trim, so it is dropped —
    // but the sink stays alive for the rows that follow it.
    const afterBig = readFileSync(traceFilePath(dir, "s-big"), "utf8");
    expect(afterBig.includes('"seq":99')).toBe(false);
    expect(afterBig.length).toBeLessThanOrEqual(before.length);
    sink(paddedEvent("s-big", 100, 40));
    expect(
      readFileSync(traceFilePath(dir, "s-big"), "utf8").includes('"seq":100'),
    ).toBe(true);
  });
});
