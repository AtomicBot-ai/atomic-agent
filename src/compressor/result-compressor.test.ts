import { describe, it, expect } from "vitest";
import { compressToolResult } from "./result-compressor.js";
import { summariseLog } from "./log-summarizer.js";

describe("compressToolResult", () => {
  it("keeps short output unchanged except formatting", () => {
    const out = compressToolResult({ tool: "read_file", status: "ok", output: "hello" });
    expect(out.summary).toContain("hello");
    expect(out.truncated).toBe(false);
  });

  it("trims long output to the configured tail and marks truncation", () => {
    const longOutput = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const out = compressToolResult(
      { tool: "run_test", status: "ok", output: longOutput },
      { maxSummaryLength: 200, maxTailLines: 4 },
    );
    expect(out.summary.length).toBeLessThanOrEqual(210);
    expect(out.summary).toContain("[omitted");
    expect(out.truncated).toBe(true);
  });

  it("extracts the first error signature when status is error", () => {
    const log = [
      "running tests ...",
      "collected 3 items",
      "test_auth.py::test_refresh FAILED",
      "E   AssertionError: session None after refresh",
      "====== 1 failed, 2 passed in 0.12s ======",
    ].join("\n");
    const out = compressToolResult({ tool: "run_test", status: "error", output: log });
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
