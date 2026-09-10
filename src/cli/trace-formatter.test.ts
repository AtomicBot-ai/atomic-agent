import { describe, it, expect } from "vitest";
import { formatTraceChronology } from "./trace-formatter.js";
import type { TraceEvent, TraceLoopDetected } from "../tracing/index.js";

/**
 * `trace show` rendering. The `loop_detected` line is the interesting one
 * here: it is the only place a human ever sees why the read-coverage
 * detector (issue #114) fired, and its payload is optional on the event,
 * so every branch of the interpolation needs pinning — including the
 * back-compat one, since old NDJSON traces carry neither `detector` nor
 * `read`.
 */

function loopDetected(
  extra: Partial<TraceLoopDetected> = {},
): TraceLoopDetected {
  return {
    type: "loop_detected",
    seq: 7,
    sessionId: "s-1",
    ts: Date.parse("2026-09-01T10:00:00.000Z"),
    stepIndex: 4,
    tool: "os.fs.read",
    count: 2,
    ...extra,
  };
}

function render(events: readonly TraceEvent[]): string {
  return formatTraceChronology(events);
}

describe("formatTraceChronology completion_truncated", () => {
  it("prints the cause, the counts and the retry on one line", () => {
    const out = render([
      {
        type: "completion_truncated",
        seq: 3,
        sessionId: "s-1",
        ts: Date.parse("2026-09-01T10:00:00.000Z"),
        turnIndex: 0,
        stepIndex: 2,
        cause: "reply_cap",
        completionTokens: 8_192,
        promptTokens: 6_000,
        requestedMaxTokens: 8_192,
        retry: "raise_cap",
        retryValue: 32_768,
      },
    ]);
    expect(out).toContain("completion_truncated");
    expect(out).toContain(
      "step=2 cause=reply_cap reply=8192 prompt=6000 cap=8192 retry=raise_cap:32768",
    );
  });
});

describe("formatTraceChronology loop_detected", () => {
  it("renders the bare line for a trace that predates the detector fields", () => {
    const line = render([loopDetected({ tool: "noop", count: 3 })]);
    expect(line).toContain("#7 loop_detected");
    expect(line).toContain("step=4 tool=noop count=3");
    // Nothing invented for fields the event does not carry.
    expect(line).not.toContain("detector=");
    expect(line).not.toContain("path=");
    expect(line).not.toContain("undefined");
  });

  it("names the sub-detector when the event carries one", () => {
    // Every detector benefits: "count=3" alone never said whether the
    // generic repeat counter, the wandering spread or a test re-run was
    // what tripped.
    const line = render([
      loopDetected({ detector: "wandering", tool: "noop" }),
    ]);
    expect(line).toContain("detector=wandering");
    expect(line).not.toContain("path=");
  });

  it("renders the file, the range and the fingerprint transition for a read repeat", () => {
    const line = render([
      loopDetected({
        detector: "read_repeat",
        level: "warn",
        read: {
          path: "/repo/src/agent/loop-detector.ts",
          startLine: 90,
          endLine: 119,
          previousFingerprint: "ab12",
          fingerprint: "ab12",
        },
      }),
    ]);
    expect(line).toContain("detector=read_repeat");
    expect(line).toContain("path=/repo/src/agent/loop-detector.ts");
    expect(line).toContain("lines=90-119");
    // Equal fingerprints on either side are the evidence that the content
    // stood still, which is what made the re-read redundant; a reader has
    // to be able to check that claim rather than take it on faith.
    expect(line).toContain("fingerprint=ab12→ab12");
  });

  it("renders an empty return as the 0-0 range it was", () => {
    const line = render([
      loopDetected({
        detector: "read_repeat",
        read: {
          path: "/repo/big.ts",
          startLine: 0,
          endLine: 0,
          previousFingerprint: "cd34",
          fingerprint: "cd34",
        },
      }),
    ]);
    expect(line).toContain("lines=0-0");
  });

  it("keeps the --step filter working on loop_detected lines", () => {
    const events: TraceEvent[] = [
      loopDetected({ stepIndex: 1, detector: "read_repeat" }),
      loopDetected({ seq: 8, stepIndex: 4, detector: "generic_repeat" }),
    ];
    const only = formatTraceChronology(events, { step: 4 });
    expect(only.split("\n")).toHaveLength(1);
    expect(only).toContain("detector=generic_repeat");
  });
});

describe("formatTraceChronology parse_failure_recovered", () => {
  const event: TraceEvent = {
    type: "parse_failure_recovered",
    seq: 11,
    sessionId: "s-1",
    ts: Date.parse("2026-09-01T10:00:00.000Z"),
    turnIndex: 0,
    stepIndex: 2,
    attempt: 1,
    budget: 2,
    reason: 'tool call "os.fs.write" arguments are not a valid JSON object',
  };

  it("says which step was retried, how far into the budget, and why", () => {
    // Without this row a post-mortem sees an inference with no tool call
    // and no text behind it, and nothing saying the step was retried.
    const line = render([event]);
    expect(line).toContain("#11 parse_failure_recovered");
    expect(line).toContain("step=2 attempt=1/2");
    expect(line).toContain("os.fs.write");
  });

  it("truncates a reason that quotes the model's own output", () => {
    const line = render([{ ...event, reason: "x".repeat(400) }]);
    expect(line.length).toBeLessThan(300);
  });
});
