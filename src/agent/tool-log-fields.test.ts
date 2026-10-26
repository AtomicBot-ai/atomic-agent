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

  it("logs an aliased move's source and its error, not the alias note (ATO-899)", () => {
    expect(
      toolLogFields(
        { src: "a.txt", dest: "b.txt" },
        result({
          tool: "os.fs.move",
          status: "error",
          summary: "os.fs.move: nothing at `a.txt`\nnote: read `src` as `from` and `dest` as `to`; …",
        }),
      ),
    ).toEqual({ path: "a.txt", reason: "os.fs.move: nothing at `a.txt`" });
  });

  it("skips the compressor's key: signature so a later quoted line stays out", () => {
    const fields = toolLogFields(
      { path: "a.py" },
      result({
        tool: "os.fs.edit",
        status: "error",
        summary:
          'key: Nearest text in the file, as JSON: "error: TOKEN"\nos.fs.edit: `oldString` was not found in the target file.\nNearest text in the file, as JSON: "error: TOKEN"',
      }),
    );
    expect(fields.reason).toBe(
      "os.fs.edit: `oldString` was not found in the target file.",
    );
  });

  it("logs no path or reason for tools outside os.fs, only the error name", () => {
    const fields = toolLogFields(
      { path: "https://api.example.com/x?token=SECRET", from: "me@example.com" },
      result({
        tool: "os.shell.run",
        status: "error",
        summary: "$ curl -H 'Authorization: Bearer SECRET' https://x\nexit: 1",
        details: { errorName: "ShellError" },
      }),
    );
    expect(fields).toEqual({ errorName: "ShellError" });
    expect(JSON.stringify(fields)).not.toContain("SECRET");
    expect(
      toolLogFields({ path: "notes" }, result({ tool: "mcp.drive.get" })),
    ).toEqual({});
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
