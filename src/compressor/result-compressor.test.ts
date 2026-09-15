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

  it("head overflow (the default) still keeps the beginning", () => {
    const out = compressToolResult(
      { tool: "page", status: "ok", output: "A".repeat(300) + "Z".repeat(300) },
      { maxSummaryLength: 200, maxTailLines: 100 },
    );
    expect(out.summary.startsWith("AAAA")).toBe(true);
    expect(out.summary).not.toContain("Z");
    expect(out.summary.endsWith("… [truncated]")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  /* The desktop session this came from: `bash -c` verification scripts
     whose echoed command filled the 400-character budget, so the model
     received the command, `exit: 0`, a few bytes and `… [truncated]` —
     never the RESULT lines it printed. */
  it("tail overflow keeps the head and the END of the output", () => {
    const script = Array.from({ length: 30 }, (_, i) => `print('step ${i}')`).join("\n");
    const output = [
      ...Array.from({ length: 60 }, (_, i) => `noise line ${i} ${"x".repeat(40)}`),
      "RESULT verdict=BIG_BANANA_CENTERED",
    ].join("\n");
    const out = compressToolResult(
      { tool: "os.shell.run", status: "ok", head: `$ bash -c ${script.split("\n")[0]} …\nexit: 0`, output },
      { maxSummaryLength: 400, maxTailLines: 40, overflow: "tail" },
    );
    expect(out.summary.length).toBeLessThanOrEqual(400);
    expect(out.summary.startsWith("$ bash -c print('step 0') …\nexit: 0\n… [truncated]\n")).toBe(true);
    expect(out.summary.endsWith("RESULT verdict=BIG_BANANA_CENTERED")).toBe(true);
    // the first kept output line is whole, not a fragment
    const firstKept = out.summary.split("\n")[3]!;
    expect(firstKept).toMatch(/^noise line \d+ x+$/);
    expect(out.truncated).toBe(true);
  });

  it("tail overflow pins the key error line next to the head", () => {
    const output = [
      "Traceback (most recent call last):",
      ...Array.from({ length: 50 }, (_, i) => `  File "<string>", line ${i}, in <module> ${"y".repeat(30)}`),
      "ModuleNotFoundError: No module named 'PIL'",
    ].join("\n");
    const out = compressToolResult(
      { tool: "os.shell.run", status: "error", head: "$ python3 -c …\nexit: 1", output },
      { maxSummaryLength: 400, maxTailLines: 40, overflow: "tail" },
    );
    expect(out.summary.startsWith("$ python3 -c …\nexit: 1\nkey: ModuleNotFoundError: No module named 'PIL'\n")).toBe(true);
    expect(out.summary.length).toBeLessThanOrEqual(400);
  });

  it("names a Python traceback by its exception line, not by its header", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "<string>", line 1, in <module>',
      "ModuleNotFoundError: No module named 'PIL'",
    ].join("\n");
    const out = compressToolResult({ tool: "os.shell.run", status: "error", output });
    expect(out.summary.split("\n")[0]).toBe("key: ModuleNotFoundError: No module named 'PIL'");
  });

  /* `key: vision call failed: … 400: {…` followed by the same line again
     used the 400-character budget twice and cut the provider's reason. */
  it("does not repeat a one-line error as its own key line", () => {
    const message = `vision call failed: openai provider 400: {"message":"Validation failed. ${"detail ".repeat(20)}image_url is not supported"}`;
    const out = compressToolResult({ tool: "vision.describe", status: "error", output: message });
    expect(out.summary).toBe(message.length <= 400 ? message : out.summary);
    expect(out.summary).not.toMatch(/^key:/);
    expect(out.summary).toContain("image_url is not supported");
  });

  it("a head with no output is the whole summary", () => {
    const out = compressToolResult(
      { tool: "os.shell.run", status: "ok", head: "$ true\nexit: 0", output: "" },
      { maxSummaryLength: 2000, maxTailLines: 40, overflow: "tail" },
    );
    expect(out.summary).toBe("$ true\nexit: 0");
    expect(out.truncated).toBe(false);
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
