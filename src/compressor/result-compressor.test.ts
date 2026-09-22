import { describe, it, expect } from "vitest";
import { compressToolResult } from "./result-compressor.js";
import { summariseLog } from "./log-summarizer.js";

describe("compressToolResult", () => {
  it("keeps short output unchanged except formatting", () => {
    const out = compressToolResult({
      tool: "read_file",
      status: "ok",
      output: "hello",
    });
    expect(out.summary).toContain("hello");
    expect(out.truncated).toBe(false);
  });

  it("trims long output to the configured tail and marks truncation", () => {
    const longOutput = Array.from({ length: 400 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const out = compressToolResult(
      { tool: "run_test", status: "ok", output: longOutput },
      { maxSummaryLength: 200, maxTailLines: 4 },
    );
    expect(out.summary.length).toBeLessThanOrEqual(210);
    expect(out.summary).toContain("[omitted");
    expect(out.truncated).toBe(true);
  });

  it("cuts an over-long summary from the start when overflow is tail", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const raw = { tool: "run_test", status: "ok" as const, output: lines.join("\n") };

    const head = compressToolResult(raw, {
      maxSummaryLength: 200,
      maxTailLines: 40,
    });
    // The default keeps the start of the tail it just took.
    expect(head.summary).toContain("[omitted");
    expect(head.summary.endsWith("… [truncated]")).toBe(true);
    expect(head.summary).not.toContain("line 399");

    const tail = compressToolResult(raw, {
      maxSummaryLength: 200,
      maxTailLines: 40,
      overflow: "tail",
    });
    expect(tail.summary.startsWith("… [truncated]\n")).toBe(true);
    expect(tail.summary.endsWith("line 399")).toBe(true);
    expect(tail.summary.length).toBeLessThanOrEqual(200);
    expect(tail.truncated).toBe(true);
  });

  it("keeps the error signature above an overflow: tail cut", () => {
    const out = compressToolResult(
      {
        tool: "run_test",
        status: "error",
        output: `error: named it\n${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}`,
      },
      { maxSummaryLength: 200, maxTailLines: 40, overflow: "tail" },
    );
    expect(out.summary.startsWith("key: error: named it\n… [truncated]\n")).toBe(
      true,
    );
    expect(out.summary.endsWith("line 399")).toBe(true);
    expect(out.summary.length).toBeLessThanOrEqual(200);
  });

  it("extracts the first error signature when status is error", () => {
    const log = [
      "running tests ...",
      "collected 3 items",
      "test_auth.py::test_refresh FAILED",
      "E   AssertionError: session None after refresh",
      "====== 1 failed, 2 passed in 0.12s ======",
    ].join("\n");
    const out = compressToolResult({
      tool: "run_test",
      status: "error",
      output: log,
    });
    expect(out.summary).toMatch(/key:/);
    expect(out.summary).toContain("AssertionError");
  });
});

describe("summariseLog", () => {
  it("counts errors, warnings, passes and failures", () => {
    const log = [
      "PASS suite/a.test.ts",
      "FAIL suite/b.test.ts",
      "  Error: boom",
      "  warn: flaky",
      "PASS suite/c.test.ts",
    ].join("\n");
    const summary = summariseLog(log);
    expect(summary.passCount).toBeGreaterThanOrEqual(2);
    expect(summary.failCount).toBeGreaterThanOrEqual(1);
    expect(summary.errorLines).toBeGreaterThanOrEqual(1);
    expect(summary.warningLines).toBeGreaterThanOrEqual(1);
    expect(summary.firstFailure).toMatch(/FAIL suite\/b/);
  });
});
