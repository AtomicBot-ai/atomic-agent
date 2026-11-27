import { describe, expect, it } from "vitest";
import { checkShellCommandGuard } from "./index.js";

/** The subshell path: the shell tool hands the guard whitespace tokens. */
function guardLine(line: string) {
  const [cmd, ...rest] = line.split(/\s+/).filter((word) => word.length > 0);
  return checkShellCommandGuard({ cmd: cmd!, rawArgs: rest, cwd: "C:\\project" });
}

describe("dangerous.encoded_exec for PowerShell (ATO-2728)", () => {
  // Each ran unasked in bypass before: the POSIX rule knew no PowerShell.
  it.each([
    "powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA=",
    "powershell -enc ZQBjAGgAbwAgAGgAaQA=",
    "powershell -e ZQBjAGgAbwAgAGgAaQA=",
    "powershell.exe -NoProfile -NonInteractive -ec ZQBjAGgAbwA=",
    "pwsh -NoLogo -EncodedC ZQBjAGgAbwA=",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe /enc ZQBjAGgAbwA=",
    "cmd /c powershell -w hidden -enc ZQBjAGgAbwA=",
  ])("asks at every level: %s", (line) => {
    expect(guardLine(line), line).toMatchObject({
      action: "approval_required",
      rule: "dangerous.encoded_exec",
      askEveryLevel: true,
      confidence: 1,
    });
  });

  it.each([
    "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('ZWNobyBoaQ==')))",
    "Invoke-Expression ([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($p)))",
    "[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))).Invoke()",
    "powershell -Command \"& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('ZWNobw=='))))\"",
  ])("asks at every level for a decoded string run as code: %s", (line) => {
    expect(guardLine(line), line).toMatchObject({
      rule: "dangerous.encoded_exec",
      askEveryLevel: true,
    });
  });

  it.each([
    "powershell -ExecutionPolicy Bypass -File build.ps1",
    "powershell -ep bypass -File build.ps1",
    "pwsh -NoProfile -Command Get-ChildItem -Exclude *.tmp",
    "pwsh -File tools/run.ps1 -e staging",
    "[Convert]::FromBase64String($b) | Set-Content -Encoding Byte out.bin",
    "certutil -hashfile setup.exe SHA256",
  ])("is not an encoded command: %s", (line) => {
    const verdict = guardLine(line);
    expect(verdict.rule, line).not.toBe("dangerous.encoded_exec");
    expect(verdict.askEveryLevel, line).toBeUndefined();
  });
});
