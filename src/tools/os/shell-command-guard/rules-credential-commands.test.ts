import { describe, expect, it } from "vitest";
import { checkShellCommandGuard } from "./index.js";

/** The subshell path: the shell tool hands the guard whitespace tokens. */
function guardLine(line: string) {
  const [cmd, ...rest] = line.split(/\s+/).filter((word) => word.length > 0);
  return checkShellCommandGuard({ cmd: cmd!, rawArgs: rest, cwd: "/tmp/project" });
}

describe("commands that print a saved credential (ATO-2505)", () => {
  // Each ran unasked in bypass before: no credential file on the line.
  it.each([
    "security find-generic-password -s github -w",
    "security find-internet-password -gs example.com",
    "security dump-keychain -d login.keychain",
    "gh auth token",
    "gh auth status --show-token",
    "aws configure get aws_secret_access_key",
    "aws configure get default.aws_session_token",
    "aws configure export-credentials --profile dev",
    "aws ecr get-login-password",
    "gcloud auth print-access-token",
    "gcloud auth application-default print-access-token",
    "az account get-access-token",
    "op read op://Private/GitHub/token",
    "op item get GitHub --reveal",
    "pass show email/work",
    "pass email/work",
    "echo url=https://github.com | git credential fill",
    "kubectl config view --raw",
    "secret-tool lookup service github",
    "docker-credential-osxkeychain get",
    "heroku auth:token",
    "sudo -u nadia gh auth token",
    "env AWS_PROFILE=dev aws configure get aws_access_key_id",
  ])("asks at every level: %s", (line) => {
    expect(guardLine(line), line).toMatchObject({
      action: "approval_required",
      rule: "dangerous.read_credentials",
      askEveryLevel: true,
    });
  });

  it.each([
    "security find-generic-password -s github",
    "gh auth status",
    "aws configure get region",
    "gcloud config list",
    "op item list",
    "pass ls",
    "pass insert email/work",
    "kubectl config view",
    "git credential-cache exit",
  ])("lists names only, not a finding: %s", (line) => {
    const verdict = guardLine(line);
    expect(verdict.rule, line).not.toBe("dangerous.read_credentials");
    expect(verdict.askEveryLevel, line).toBeUndefined();
  });
});
