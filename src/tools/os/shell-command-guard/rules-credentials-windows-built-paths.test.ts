import { describe, expect, it } from "vitest";
import { checkShellCommandGuard } from "./index.js";
import { ASK_EVERY_LEVEL_CONFIDENCE } from "./arg-scan-finding.js";
import { matchWindowsCredentialRead } from "./rules-credentials-windows.js";
import { normaliseCommand } from "./normalise.js";

/** The subshell path: the shell tool hands the guard whitespace tokens. */
function guardLine(line: string) {
  const [cmd, ...rest] = line.split(/\s+/).filter((word) => word.length > 0);
  return checkShellCommandGuard({ cmd: cmd!, rawArgs: rest, cwd: "C:\\project" });
}

function windowsFinding(line: string) {
  const [cmd, ...rest] = line.split(/\s+/).filter((word) => word.length > 0);
  return matchWindowsCredentialRead(normaliseCommand({ cmd: cmd!, rawArgs: rest, cwd: "C:\\p" }));
}

describe("review round 3 (#1945): escapes, built strings, prefixes, .NET reads", () => {
  // Each line ran unasked at level 5 at 053be74 (rule `default`). Lines
  // with a backtick or `${...}` are plain strings, not template literals.
  it.each([
    // F1945-R3.1: PowerShell's backtick escape.
    'powershell -c "gc ~/.s`sh/id_rsa"',
    'powershell -c "& {gc ~/.s`sh/id_rsa}"',
    "gc $HOME\\.a`ws\\credentials",
    // F1945-R3.2: a string split inside the entry name.
    String.raw`gc ('~/.s'+'sh/id_rsa')`,
    String.raw`gc ($HOME + '/.s' + 'sh/id_rsa')`,
    String.raw`powershell -c "[IO.File]::ReadAllText($HOME+'\.s'+'sh\id_rsa')"`,
    String.raw`gc ('~/.ss{0}/id_rsa' -f 'h')`,
    String.raw`gc ('~/.sXh/id_rsa' -replace 'X','s')`,
    String.raw`gc ('~/.s'+[char]115+'h/id_rsa')`,
    String.raw`gc (Join-Path ~ ('.s'+'sh') id_rsa)`,
    String.raw`gc ('C:\Use'+'rs\x\.ssh\id_rsa')`,
    // F1945-R3.3: `..` or a variable root before `\Users`.
    String.raw`type C:\Windows\..\Users\x\.ssh\id_rsa`,
    String.raw`type %SystemDrive%\Users\x\.ssh\id_rsa`,
    String.raw`type %ALLUSERSPROFILE%\..\Users\x\.aws\credentials`,
    // F1945-R3.4: .NET and object reads with no reader word.
    "(gi ~/.ssh/id_rsa).OpenText().ReadToEnd()",
    "(gi ~/.ssh/id_rsa).OpenRead()",
    "New-Object IO.StreamReader ~/.ssh/id_rsa",
    String.raw`[IO.StreamReader]::new('C:\Users\x\.ssh\id_rsa')`,
    String.raw`[IO.FileStream]::new('C:\Users\x\.aws\credentials', 'Open')`,
    // F1945-R3.6: a credential path stored in a variable, read later.
    "$p='~/.ssh/id_rsa'; gc $p",
    String.raw`set K=%USERPROFILE%\.ssh\id_rsa& call type %K%`,
  ])("asks at every level, as a credential read: %s", (line) => {
    const verdict = guardLine(line);
    expect(verdict, line).toMatchObject({
      action: "approval_required",
      rule: "dangerous.read_credentials",
      askEveryLevel: true,
    });
    expect(verdict.confidence).toBeGreaterThanOrEqual(ASK_EVERY_LEVEL_CONFIDENCE);
    expect(verdict.reason, line).toMatch(/^reads /);
    expect(windowsFinding(line), line).not.toBeNull();
  });

  // Test-mutation gap: `$(` and `@(` alone make the line a block.
  it.each(["Write-Output $(gi ~/.ssh/id_rsa)", "Write-Output @(gi ~/.ssh/id_rsa)"])(
    "a subexpression is a block the guard cannot follow: %s",
    (line) => {
      expect(windowsFinding(line), line).toMatchObject({
        id: "dangerous.read_credentials",
        reason: expect.stringMatching(/^reads a credential file in a block/),
      });
    },
  );

  // Test-mutation gap: with `-Path` named, the first positional word is the destination.
  it("Copy-Item -Path a <key> is a write into the key, not a read", () => {
    expect(windowsFinding(String.raw`Copy-Item -Path C:\tmp\x $HOME\.ssh\id_rsa`)).toBeNull();
    expect(windowsFinding(String.raw`Copy-Item -Path $HOME\.ssh\id_rsa C:\tmp\x`)).not.toBeNull();
  });

  it.each([
    // Strings built away from the home folder, `-f` as a POSIX flag.
    "$x = 'a' + 'b'; gc ~/notes.txt",
    "tail -f ~/app.log",
    "gc ('C:\\project\\' + 'notes.txt')",
    // A variable without a credential path, an object with no path.
    "$p = '~/notes.txt'; gc $p",
    "$name = 'x'; Write-Output $name",
    "New-Object System.Net.WebClient",
    // `\Users\<name>` below a folder that is no credential entry.
    String.raw`type C:\Windows\..\Users\x\notes.txt`,
    String.raw`type %SystemDrive%\Users\x\.ssh\id_rsa.pub`,
  ])("is not a credential read: %s", (line) => {
    expect(windowsFinding(line), line).toBeNull();
    expect(guardLine(line).askEveryLevel, line).toBeUndefined();
  });
});
