import { describe, expect, it } from "vitest";
import { findUnknownArguments, suggestKey } from "./unknown-argument-guard.js";

const NOT_RUN = "— the call was not run; re-emit it with the right keys";
/** `os.shell.run`'s schema keys in schema order: the command form, then the job forms (F47). */
const SHELL_KEYS = ["cmd", "args", "cwd", "timeoutMs", "keep", "wait", "kill", "jobs"];

describe("findUnknownArguments", () => {
  it("refuses the live Gemma call: a flag used as a key, the script under it", () => {
    const report = findUnknownArguments("os.shell.run", {
      cmd: "python3",
      "-e": "import os\nos.rename('a', 'b')",
    });
    expect(report).not.toBeNull();
    expect(report!.unknownKeys).toEqual(["-e"]);
    expect(report!.expectedKeys).toEqual(SHELL_KEYS);
    expect(report!.nearest).toEqual([]);
    expect(report!.message).toBe(
      `unknown argument \`-e\` for os.shell.run (expected: ${SHELL_KEYS.join(", ")}; ` +
        `put the script in args: ["-c", "…"]) ${NOT_RUN}`,
    );
  });

  it("never echoes a value, only keys", () => {
    const report = findUnknownArguments("os.shell.run", {
      cmd: "python3",
      "-e": "SECRET SCRIPT",
    });
    expect(report!.message).not.toContain("SECRET");
  });

  it("suggests `args` for `-args` (the other live call)", () => {
    const report = findUnknownArguments("os.shell.run", {
      cmd: "python3",
      "-args": ["-c", "print(1)"],
    });
    expect(report!.unknownKeys).toEqual(["-args"]);
    expect(report!.nearest).toEqual([{ received: "-args", expected: "args" }]);
    expect(report!.message).toBe(
      `unknown argument \`-args\` for os.shell.run (expected: ${SHELL_KEYS.join(", ")}; ` +
        `did you mean \`args\`?) ${NOT_RUN}`,
    );
  });

  it("names the interpreter's own script flag in the hint", () => {
    expect(
      findUnknownArguments("os.shell.run", { cmd: "node", "-e": "1" })!.message,
    ).toContain('put the script in args: ["-e", "…"]');
    expect(
      findUnknownArguments("os.shell.run", {
        cmd: "/usr/bin/python3.12",
        "-c": "1",
      })!.message,
    ).toContain('put the script in args: ["-c", "…"]');
    // The hint is about a flag used as a key; a misspelt key gets the
    // suggestion instead.
    expect(
      findUnknownArguments("os.shell.run", { cmd: "ls", arg: ["-la"] })!.message,
    ).not.toContain("put the script");
  });

  it("suggests the schema key within two edits, case-insensitively", () => {
    expect(findUnknownArguments("os.fs.read", { Path: "a.txt" })!.message).toBe(
      "unknown argument `Path` for os.fs.read (expected: path, maxBytes, offset, limit, lineNumbers; " +
        `did you mean \`path\`?) ${NOT_RUN}`,
    );
    expect(
      findUnknownArguments("os.fs.edit", {
        path: "a.ts",
        oldstring: "x",
        newString: "y",
      })!.message,
    ).toBe(
      "unknown argument `oldstring` for os.fs.edit (expected: path, oldString, newString, replaceAll; " +
        `did you mean \`oldString\`?) ${NOT_RUN}`,
    );
  });

  it("lists several unknown keys with a suggestion per key", () => {
    const report = findUnknownArguments("os.shell.run", {
      cmd: "python3",
      "-e": "print(1)",
      "-args": ["-c", "print(1)"],
    });
    expect(report!.unknownKeys).toEqual(["-e", "-args"]);
    expect(report!.message).toBe(
      `unknown arguments \`-e\`, \`-args\` for os.shell.run (expected: ${SHELL_KEYS.join(", ")}; ` +
        "did you mean `args` instead of `-args`?; " +
        `put the script in args: ["-c", "…"]) ${NOT_RUN}`,
    );
  });

  it("says a tool takes no arguments when its schema has none", () => {
    expect(
      findUnknownArguments("os.clipboard.read", { format: "text" })!.message,
    ).toBe(
      `unknown argument \`format\` for os.clipboard.read (expected: (no arguments)) ${NOT_RUN}`,
    );
  });

  it("leaves a valid call alone", () => {
    expect(
      findUnknownArguments("os.shell.run", { cmd: "ls", args: ["-la"] }),
    ).toBeNull();
    expect(
      findUnknownArguments("os.fs.read", { path: "a.txt", limit: 40 }),
    ).toBeNull();
  });

  it("exempts a tool with no registered schema", () => {
    expect(
      findUnknownArguments("mcp.some.server.tool", { whatever: 1, "-e": "x" }),
    ).toBeNull();
    expect(findUnknownArguments("no.such.tool", { x: 1 })).toBeNull();
  });

  it("lets F33's key normalisation run first: a quoted or fused key is not unknown", () => {
    // `"path"` wrapped in its own quotes, and a key fused with a prompt
    // fragment — both are renamed at dispatch, so neither is refused.
    expect(
      findUnknownArguments("os.fs.read", { '"path"': "a.txt" }),
    ).toBeNull();
    expect(
      findUnknownArguments("os.fs.read", {
        path: "a.txt",
        "<label>limit</label>,limit": 40,
      }),
    ).toBeNull();
  });
});

describe("suggestKey", () => {
  it("strips leading dashes and underscores before an exact match", () => {
    expect(suggestKey("-args", ["cmd", "args"])).toBe("args");
    expect(suggestKey("--cwd", ["cmd", "args", "cwd"])).toBe("cwd");
    expect(suggestKey("__path", ["path"])).toBe("path");
    expect(suggestKey("-Args", ["cmd", "args"])).toBe("args");
  });

  it("falls back to the nearest key within two edits", () => {
    expect(suggestKey("patth", ["path", "limit"])).toBe("path");
    expect(suggestKey("oldstring", ["path", "oldString"])).toBe("oldString");
  });

  it("suggests nothing for a bare flag: `-e` is not `cmd`, nor `keep`", () => {
    expect(suggestKey("-e", SHELL_KEYS)).toBeNull();
    expect(suggestKey("-c", SHELL_KEYS)).toBeNull();
    expect(suggestKey("-", ["cmd"])).toBeNull();
  });
});
