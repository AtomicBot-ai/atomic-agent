import { describe, expect, it } from "vitest";

import {
  extractSafeCode,
  sanitizeStack,
  scrubError,
} from "./error-scrubber.js";

describe("sanitizeStack", () => {
  it("reduces filesystem paths to basenames (strips home dir / username)", () => {
    const stack = [
      "Error: boom",
      "    at doThing (/Users/aleksejkalina/code/app/cli.mjs:12:34)",
      "    at /Users/aleksejkalina/code/app/other.js:1:2",
      "    at process (node:internal/process/task_queues:95:5)",
    ].join("\n");
    const frames = sanitizeStack(stack);
    expect(frames).toEqual([
      { function: "doThing", filename: "cli.mjs", lineno: 12, colno: 34 },
      { filename: "other.js", lineno: 1, colno: 2 },
      {
        function: "process",
        filename: "node:internal/process/task_queues",
        lineno: 95,
        colno: 5,
      },
    ]);
    // No frame leaks the absolute path / username.
    for (const f of frames) {
      expect(f.filename).not.toContain("aleksejkalina");
      expect(f.filename).not.toContain("/Users/");
    }
  });

  it("returns an empty array for a missing stack", () => {
    expect(sanitizeStack(undefined)).toEqual([]);
  });
});

describe("extractSafeCode", () => {
  it("pulls http status and errno-style code, ignores freeform fields", () => {
    expect(extractSafeCode({ status: 503, code: "ECONNREFUSED" })).toEqual({
      httpStatus: 503,
      code: "ECONNREFUSED",
    });
    // A non-enum `code` (could contain user data) is dropped.
    expect(extractSafeCode({ code: "failed to read /home/x" })).toEqual({});
    expect(extractSafeCode(null)).toEqual({});
  });
});

describe("scrubError", () => {
  it("omits the raw message by default (allowlist policy)", () => {
    const err = new Error("failed reading /Users/alex/secret.txt");
    err.name = "TypeError";
    const ev = scrubError(err, { source: "uncaughtException" });
    expect(ev.errorType).toBe("TypeError");
    expect(ev.message).toBeUndefined();
    expect(ev.source).toBe("uncaughtException");
  });

  it("reads a known LLM category off the error", () => {
    const err = Object.assign(new Error("transport boom"), {
      name: "TransportError",
      category: "transport",
      status: 502,
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.category).toBe("transport");
    expect(ev.httpStatus).toBe(502);
    expect(ev.message).toBeUndefined();
  });

  it("prefers the explicit category override", () => {
    const err = new Error("x");
    const ev = scrubError(err, { source: "llm_failure", category: "grammar" });
    expect(ev.category).toBe("grammar");
  });
});
