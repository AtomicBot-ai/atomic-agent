import { describe, expect, it } from "vitest";

import {
  defaultPrintEnvShell,
  formatCommandLine,
  formatEnvLine,
  parsePrintEnvShell,
  windowsArgQuote,
} from "./print-env-format.js";

/** ATO-2758: `atag launch --print-env` lines per shell. */
describe("print-env format", () => {
  it("defaults to PowerShell on Windows and a POSIX shell elsewhere", () => {
    expect(defaultPrintEnvShell("win32")).toBe("powershell");
    expect(defaultPrintEnvShell("darwin")).toBe("posix");
    expect(defaultPrintEnvShell("linux")).toBe("posix");
    expect(parsePrintEnvShell("pwsh")).toBe("powershell");
    expect(parsePrintEnvShell("CMD")).toBe("cmd");
    expect(parsePrintEnvShell("bash")).toBe("posix");
    expect(parsePrintEnvShell("fish")).toBeNull();
  });

  it("quotes values for each shell", () => {
    expect(formatEnvLine("posix", "A", "it's")).toBe(`export A='it'\\''s'`);
    expect(formatEnvLine("powershell", "A", "it's $HOME")).toBe(`$env:A = 'it''s $HOME'`);
    expect(formatEnvLine("cmd", "A", "a b&c")).toBe('set "A=a b&c"');
    // After an odd number of quotes the `&` is outside cmd's quoting and needs a caret.
    expect(formatEnvLine("cmd", "A", 'a"b&c')).toBe('set "A=a"b^&c"');
    expect(formatEnvLine("cmd", "A", '{"x":"1&2"}')).toBe('set "A={"x":"1^&2"}"');
  });

  it("builds a command line PowerShell and cmd can run", () => {
    expect(formatCommandLine("powershell", "C:\\Program Files\\nodejs\\claude.cmd", ["--continue"])).toBe(
      "& 'C:\\Program Files\\nodejs\\claude.cmd' --continue",
    );
    expect(formatCommandLine("powershell", "codex", ["-c", 'model_provider="atomic"', "--"])).toBe(
      `codex -c 'model_provider="atomic"' '--'`,
    );
    expect(formatCommandLine("cmd", "C:\\Program Files\\x.exe", ['k="v"'])).toBe('"C:\\Program Files\\x.exe" "k=\\"v\\""');
    expect(formatCommandLine("posix", "/usr/bin/codex", ["a b"])).toBe("/usr/bin/codex 'a b'");
  });

  it("doubles backslashes only before a quote or the closing quote on Windows", () => {
    expect(windowsArgQuote("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(windowsArgQuote("plain")).toBe("plain");
    expect(windowsArgQuote("")).toBe('""');
  });
});
