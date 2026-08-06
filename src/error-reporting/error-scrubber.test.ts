import { describe, expect, it } from "vitest";

import {
  extractSafeCode,
  extractSafeReason,
  extractSafeTool,
  extractSafeTransportHost,
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

describe("extractSafeReason", () => {
  it("allows the known ModelFailureReason enum values", () => {
    expect(extractSafeReason({ reason: "truncated" })).toBe("truncated");
    expect(extractSafeReason({ reason: "empty" })).toBe("empty");
    expect(extractSafeReason({ reason: "no_stop" })).toBe("no_stop");
  });

  it("drops an unrecognised reason (could be freeform text)", () => {
    expect(extractSafeReason({ reason: "user typed something weird" })).toBeUndefined();
    expect(extractSafeReason(null)).toBeUndefined();
  });
});

describe("extractSafeTool", () => {
  it("allows a bounded registry-style tool identifier", () => {
    expect(extractSafeTool({ tool: "os.fs.read" })).toBe("os.fs.read");
    expect(extractSafeTool({ tool: "unknown" })).toBe("unknown");
  });

  it("drops a tool value that is not a bounded identifier (could echo model output)", () => {
    expect(extractSafeTool({ tool: "please read /Users/alex/notes.txt" })).toBeUndefined();
    expect(extractSafeTool({ tool: "a".repeat(65) })).toBeUndefined();
  });
});

describe("extractSafeTransportHost", () => {
  it("extracts only the host, dropping path and query", () => {
    expect(
      extractSafeTransportHost({ url: "http://127.0.0.1:8080/completion?x=1" }),
    ).toBe("127.0.0.1:8080");
  });

  it("drops a malformed url", () => {
    expect(extractSafeTransportHost({ url: "not a url" })).toBeUndefined();
    expect(extractSafeTransportHost({})).toBeUndefined();
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

  it("carries ModelError.reason through when it is a known enum value", () => {
    const err = Object.assign(new Error("cut off"), {
      name: "ModelError",
      category: "model",
      reason: "truncated",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.reason).toBe("truncated");
  });

  it("carries ToolExecutionError.tool through when it is a bounded identifier", () => {
    const err = Object.assign(new Error("boom"), {
      name: "ToolExecutionError",
      category: "tool",
      tool: "os.shell.run",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.tool).toBe("os.shell.run");
  });

  it("carries TransportError's url host through, never the full url", () => {
    const err = Object.assign(new Error("net down"), {
      name: "TransportError",
      category: "transport",
      status: null,
      url: "http://localhost:8080/completion",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.transportHost).toBe("localhost:8080");
  });

  it("prefers the cause's stack over the wrapper's own stack", () => {
    function throwOriginal(): never {
      throw new TypeError("cannot read x of undefined");
    }
    let cause: Error;
    try {
      throwOriginal();
      throw new Error("unreachable");
    } catch (err) {
      cause = err as Error;
    }
    const wrapper = Object.assign(new Error("ToolExecutionError"), {
      name: "ToolExecutionError",
      category: "tool",
      tool: "unknown",
      cause,
    });
    const ev = scrubError(wrapper, { source: "llm_failure" });
    // The wrapper's own stack would only ever show the `scrubError` test
    // call site, never `throwOriginal` — this pins that the cause's frame
    // (where the real failure happened) wins.
    expect(ev.frames.some((f) => f.function === "throwOriginal")).toBe(true);
  });

  it("falls back to the wrapper's own stack when cause is not an Error", () => {
    const err = Object.assign(new Error("boom"), {
      name: "ToolExecutionError",
      cause: "a plain string cause, not an Error",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.causeType).toBeUndefined();
    expect(ev.frames).toEqual(sanitizeStack(err.stack));
  });

  it("surfaces the cause's class name as causeType, distinct from the wrapper's errorType", () => {
    const cause = new RangeError("out of bounds");
    const wrapper = Object.assign(new Error("ToolExecutionError"), {
      name: "ToolExecutionError",
      cause,
    });
    const ev = scrubError(wrapper, { source: "llm_failure" });
    expect(ev.errorType).toBe("ToolExecutionError");
    expect(ev.causeType).toBe("RangeError");
  });

  it("omits causeType when the error has no cause", () => {
    const err = new Error("plain failure");
    const ev = scrubError(err, { source: "uncaughtException" });
    expect(ev.causeType).toBeUndefined();
  });
});
