import { describe, expect, it } from "vitest";
import { describeArgumentError, nearestKey } from "./argument-error-hint.js";

describe("describeArgumentError", () => {
  it("appends the received keys, the schema keys and the nearest key", () => {
    // A local worker sent `patternes` to os.fs.grep.
    const hint = describeArgumentError({
      tool: "os.fs.grep",
      args: { patternes: ".add(", path: "js" },
      message: "os.fs.grep: `pattern` must be a non-empty string",
    });
    expect(hint).not.toBeNull();
    expect(hint!.receivedKeys).toEqual(["patternes", "path"]);
    expect(hint!.expectedKeys[0]).toBe("pattern");
    expect(hint!.expectedKeys).toContain("glob");
    expect(hint!.nearest).toEqual([
      { received: "patternes", expected: "pattern" },
    ]);
    expect(hint!.message).toBe(
      "os.fs.grep: `pattern` must be a non-empty string — " +
        `received keys: patternes, path; expected: ${hint!.expectedKeys.join(", ")}; ` +
        "did you mean `pattern` instead of `patternes`?",
    );
  });

  it("echoes keys only, never values", () => {
    const hint = describeArgumentError({
      tool: "os.fs.write",
      args: { pth: "a.js", content: "SECRET CONTENT" },
      message: "os.fs.write: `path` must be a non-empty string",
    });
    expect(hint!.message).not.toContain("SECRET");
    expect(hint!.message).toContain("received keys: pth, content");
    expect(hint!.message).toContain("did you mean `path` instead of `pth`?");
  });

  it("reports no expected keys for a tool without a schema", () => {
    const hint = describeArgumentError({
      tool: "mcp.some.server.tool",
      args: { q: 1 },
      message: "`query` is required",
    });
    expect(hint!.expectedKeys).toEqual([]);
    expect(hint!.nearest).toEqual([]);
    expect(hint!.message).toBe("`query` is required — received keys: q");
  });

  it("says (none) when no keys arrived", () => {
    const hint = describeArgumentError({
      tool: "os.fs.read",
      args: {},
      message: "os.fs.read: `path` must be a non-empty string",
    });
    expect(hint!.message).toContain("received keys: (none)");
  });

  it("leaves a runtime failure alone", () => {
    expect(
      describeArgumentError({
        tool: "os.fs.read",
        args: { path: "nope.txt" },
        message: "ENOENT: no such file or directory, open 'nope.txt'",
      }),
    ).toBeNull();
    expect(
      describeArgumentError({
        tool: "os.fs.grep",
        args: { pattern: "x", path: "/gone" },
        message: "os.fs.grep: path does not exist: /gone",
      }),
    ).toBeNull();
  });

  it("does not suggest a key that is further than two edits away", () => {
    const hint = describeArgumentError({
      tool: "os.fs.read",
      args: { filename: "a" },
      message: "os.fs.read: `path` must be a non-empty string",
    });
    expect(hint!.nearest).toEqual([]);
    expect(hint!.message).not.toContain("did you mean");
  });
});

describe("nearestKey", () => {
  it("matches case-insensitively within two edits, first in schema order on a tie", () => {
    expect(nearestKey("Path", ["path", "offset"])).toBe("path");
    expect(nearestKey("limits", ["path", "limit"])).toBe("limit");
    expect(nearestKey("ab", ["abc", "abd"])).toBe("abc");
    expect(nearestKey("content", ["path", "offset"])).toBeNull();
  });
});
