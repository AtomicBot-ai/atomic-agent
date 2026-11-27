import { describe, expect, it } from "vitest";
import { normaliseCommand } from "./normalise.js";
import { powershellCommandLines } from "./powershell-command-lines.js";
import { matchCredentialRead } from "./rules-credentials.js";

function linesOf(line: string): string[] {
  const [cmd, ...rest] = line.split(/\s+/).filter((word) => word.length > 0);
  const input = normaliseCommand({ cmd: cmd!, rawArgs: rest, cwd: "/project" });
  return powershellCommandLines(input, "/project").map((inner) => inner.joined);
}

describe("powershellCommandLines (ATO-2728, review round 1)", () => {
  it.each([
    [`powershell -c "Get-Content ~/.ssh/id_rsa"`, "Get-Content ~/.ssh/id_rsa"],
    [`pwsh -NoProfile -Command "cd ~; gc .ssh/id_rsa"`, "cd ~; gc .ssh/id_rsa"],
    [`pwsh -ep Bypass -w hidden -com "gc x"`, "gc x"],
    [`pwsh -Command:"gc x"`, "gc x"],
    [`powershell -NoLogo "gc x"`, "gc x"],
    [`env pwsh -cwa "gc x"`, "gc x"],
  ])("unwraps %s", (line, inner) => {
    expect(linesOf(line)).toEqual([inner]);
  });

  it.each([
    "pwsh -File run.ps1 -c x",
    "pwsh run.ps1 -c x",
    "powershell -enc ZQBjAGgAbwA=",
    "pwsh -NoProfile",
  ])("finds no command line in %s", (line) => {
    expect(linesOf(line)).toEqual([]);
  });

  it("gives the POSIX rule the inner cd and reader (F1945.1)", () => {
    const [inner] = powershellCommandLines(
      normaliseCommand({ cmd: "pwsh", rawArgs: ["-c", '"cd ~; gc .ssh/id_rsa"'], cwd: "/project" }),
      "/project",
    );
    expect(inner).toBeDefined();
    expect(matchCredentialRead(inner!, { cmd: "pwsh", rawArgs: [], cwd: "/project" })).toMatchObject({
      id: "dangerous.read_credentials",
      confidence: 0.9,
    });
  });
});
