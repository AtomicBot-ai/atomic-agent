import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDirectInvocation,
  buildSubshellInvocation,
  quoteCmdArg,
} from "./shell-invocation.js";

const COMSPEC = "C:\\Windows\\system32\\cmd.exe";

function asPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildSubshellInvocation", () => {
  it("runs `sh -c <line>` on POSIX, with Node's own quoting", () => {
    asPlatform("darwin");
    expect(buildSubshellInvocation("echo hi | grep h")).toEqual({
      command: "sh",
      args: ["-c", "echo hi | grep h"],
      windowsVerbatimArguments: false,
    });
  });

  // ATO-246: without verbatim, Node quoted the line by MSVCRT rules and
  // the trailing `\` before its closing quote came out doubled.
  describe("on Windows", () => {
    function win32(line: string) {
      asPlatform("win32");
      vi.stubEnv("ComSpec", COMSPEC);
      return buildSubshellInvocation(line);
    }

    it("wraps the line for `/s` and spawns it verbatim", () => {
      expect(win32("echo hi | findstr h")).toEqual({
        command: COMSPEC,
        args: ["/d", "/s", "/c", '"echo hi | findstr h"'],
        windowsVerbatimArguments: true,
      });
    });

    it("keeps a trailing backslash single", () => {
      expect(win32("cmd /c dir C:\\").args[3]).toBe('"cmd /c dir C:\\"');
      expect(win32("dir C:\\").args[3]).toBe('"dir C:\\"');
    });

    it("keeps the line's own quotes, a quoted path ending in `\\` included", () => {
      expect(win32('dir "C:\\Program Files\\"').args[3]).toBe(
        '"dir "C:\\Program Files\\""',
      );
      expect(win32('"C:\\Program Files\\app.exe" --version').args[3]).toBe(
        '""C:\\Program Files\\app.exe" --version"',
      );
    });

    it("falls back to cmd.exe without a ComSpec", () => {
      asPlatform("win32");
      vi.stubEnv("ComSpec", "");
      expect(buildSubshellInvocation("ver").command).toBe("cmd.exe");
    });
  });
});

describe("buildDirectInvocation", () => {
  it("passes every command through untouched on POSIX", () => {
    asPlatform("linux");
    expect(buildDirectInvocation("cmd", ["/c", "dir", "C:\\"])).toEqual({
      command: "cmd",
      args: ["/c", "dir", "C:\\"],
      windowsVerbatimArguments: false,
    });
  });

  it("passes a Windows command other than cmd.exe through untouched", () => {
    asPlatform("win32");
    expect(buildDirectInvocation("git", ["log", "C:\\a b\\"])).toEqual({
      command: "git",
      args: ["log", "C:\\a b\\"],
      windowsVerbatimArguments: false,
    });
  });

  describe("cmd.exe on Windows", () => {
    function cmd(command: string, args: string[]) {
      asPlatform("win32");
      return buildDirectInvocation(command, args);
    }

    it("spawns `cmd /c dir C:\\` verbatim, the backslash single", () => {
      expect(cmd("cmd", ["/c", "dir", "C:\\"])).toEqual({
        command: "cmd",
        args: ["/c", "dir", "C:\\"],
        windowsVerbatimArguments: true,
      });
    });

    it("recognises cmd.exe by any spelling or path", () => {
      const names = ["CMD", "cmd.exe", COMSPEC, "C:/Windows/System32/CMD.EXE"];
      for (const name of names) {
        expect(cmd(name, ["/c", "ver"]).windowsVerbatimArguments).toBe(true);
      }
      expect(cmd("cmdx", ["/c", "ver"]).windowsVerbatimArguments).toBe(false);
    });

    it("quotes a token with spaces without doubling its trailing backslash", () => {
      expect(cmd("cmd", ["/c", "dir", "C:\\Program Files\\"]).args).toEqual([
        "/c",
        "dir",
        '"C:\\Program Files\\"',
      ]);
    });

    it("quotes a whole line given as one token, which cmd /c then unwraps", () => {
      expect(cmd("cmd", ["/c", "dir C:\\"]).args).toEqual(["/c", '"dir C:\\"']);
    });

    it("leaves a token the model already quoted for cmd as it is", () => {
      expect(cmd("cmd", ["/c", 'dir "C:\\Program Files\\"']).args).toEqual([
        "/c",
        'dir "C:\\Program Files\\"',
      ]);
    });

    it("keeps operators bare and an empty token visible", () => {
      expect(cmd("cmd", ["/c", "dir", "&&", "echo", ""]).args).toEqual([
        "/c",
        "dir",
        "&&",
        "echo",
        '""',
      ]);
    });
  });
});

describe("quoteCmdArg", () => {
  it("leaves plain tokens untouched", () => {
    expect(quoteCmdArg("node")).toBe("node");
    expect(quoteCmdArg("C:\\Tools\\rg.exe")).toBe("C:\\Tools\\rg.exe");
    expect(quoteCmdArg("C:\\")).toBe("C:\\");
  });

  it("quotes tokens with spaces", () => {
    expect(quoteCmdArg("C:\\Program Files\\app.exe")).toBe(
      '"C:\\Program Files\\app.exe"',
    );
  });

  it("never doubles a trailing backslash", () => {
    expect(quoteCmdArg("C:\\Program Files\\")).toBe('"C:\\Program Files\\"');
  });

  it("quotes tokens with cmd metacharacters", () => {
    expect(quoteCmdArg("a&b")).toBe('"a&b"');
    expect(quoteCmdArg("50%")).toBe('"50%"');
  });

  it("doubles embedded quotes", () => {
    expect(quoteCmdArg('a "b" c')).toBe('"a ""b"" c"');
  });

  it("represents an empty token as a quoted empty string", () => {
    expect(quoteCmdArg("")).toBe('""');
  });
});
