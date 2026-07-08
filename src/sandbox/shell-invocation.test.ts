import { describe, expect, it } from "vitest";
import { buildSubshellInvocation, quoteCmdArg } from "./shell-invocation.js";

describe("buildSubshellInvocation", () => {
  it("routes to the platform subshell for the current OS", () => {
    const inv = buildSubshellInvocation("echo hi | findstr h");
    if (process.platform === "win32") {
      expect(inv.command.toLowerCase()).toContain("cmd");
      expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(inv.args[3]).toBe("echo hi | findstr h");
    } else {
      expect(inv.command).toBe("sh");
      expect(inv.args).toEqual(["-c", "echo hi | findstr h"]);
    }
  });
});

describe("quoteCmdArg", () => {
  it("leaves plain tokens untouched", () => {
    expect(quoteCmdArg("node")).toBe("node");
    expect(quoteCmdArg("C:\\Tools\\rg.exe")).toBe("C:\\Tools\\rg.exe");
  });

  it("quotes tokens with spaces", () => {
    expect(quoteCmdArg("C:\\Program Files\\app.exe")).toBe(
      '"C:\\Program Files\\app.exe"',
    );
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
