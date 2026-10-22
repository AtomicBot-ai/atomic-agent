import { describe, expect, it } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { TOOL_LOG_FIELD_MAX_CHARS, toolLogFields } from "./tool-log-fields.js";

const result = (
  overrides: Partial<CompressedToolResult> = {},
): CompressedToolResult => ({
  tool: "os.fs.read",
  status: "ok",
  summary: "line 1\nline 2",
  details: {},
  truncated: false,
  ...overrides,
});

describe("toolLogFields", () => {
  it("names the path and the first line of the error for a failed call", () => {
    const fields = toolLogFields(
      { path: "/dev/null" },
      result({
        status: "error",
        summary: "\n/dev/null is not a regular file: it is a device\nmore detail",
        details: { errorName: "NotARegularFileError" },
      }),
    );
    expect(fields).toEqual({
      path: "/dev/null",
      reason: "/dev/null is not a regular file: it is a device",
      errorName: "NotARegularFileError",
    });
  });

  it("keeps the path but no reason for a successful call, and never the output", () => {
    const fields = toolLogFields(
      { path: "notes.txt" },
      result({ summary: "secret file body" }),
    );
    expect(fields).toEqual({ path: "notes.txt" });
    expect(JSON.stringify(fields)).not.toContain("secret file body");
  });

  it("falls back to the move source and ignores calls with no path", () => {
    expect(toolLogFields({ from: "a.txt", to: "b.txt" }, result())).toEqual({
      path: "a.txt",
    });
    expect(toolLogFields({ query: "x" }, result())).toEqual({});
    expect(toolLogFields(undefined, result())).toEqual({});
  });

  it("clips a long path and a long reason", () => {
    const long = "x".repeat(TOOL_LOG_FIELD_MAX_CHARS + 50);
    const fields = toolLogFields(
      { path: long },
      result({ status: "error", summary: long }),
    );
    expect(fields.path).toHaveLength(TOOL_LOG_FIELD_MAX_CHARS + 1);
    expect(fields.reason).toHaveLength(TOOL_LOG_FIELD_MAX_CHARS + 1);
  });
});
