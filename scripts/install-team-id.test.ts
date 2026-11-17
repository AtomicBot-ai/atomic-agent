import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * install.sh pins the Apple Team ID of a signed macOS binary (ATO-760):
 * a valid signature from someone else's Developer ID is refused, and so is
 * an ad-hoc or unsigned binary (no Team ID). The function is cut out of the
 * script and run under `sh` with a stub `codesign` on PATH, so the test
 * runs on any OS.
 */
const script = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "install.sh"),
  "utf8",
);

function extractFunction(name: string): string {
  const start = script.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(teamLine: string, expected: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "install-team-id-"));
  dirs.push(dir);
  const stub = join(dir, "codesign");
  // `codesign -dv` prints its answer on stderr.
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' 'Identifier=atomic-agent' '${teamLine}' >&2\n`);
  chmodSync(stub, 0o755);
  const body = `set -eu\nEXPECTED_TEAM_ID='${expected}'\n${extractFunction("verify_team_id")}\nverify_team_id /bin/sh\necho passed\n`;
  const res = spawnSync("sh", ["-c", body], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  return { status: res.status, stderr: res.stderr };
}

describe("install.sh Team ID pin", () => {
  it("defaults to the release workflow's Team ID for the default repo only", () => {
    expect(script).toContain('TEAM_ID_DEFAULT="MU9G7XKJUL"');
    // `-`, not `:-`: an explicitly empty ATOMIC_AGENT_TEAM_ID turns the pin off.
    expect(script).toContain('EXPECTED_TEAM_ID="${ATOMIC_AGENT_TEAM_ID-$TEAM_ID_DEFAULT}"');
    expect(script).toContain('EXPECTED_TEAM_ID="${ATOMIC_AGENT_TEAM_ID:-}"');
  });

  it("resolves ATOMIC_AGENT_TEAM_ID='' to no pin and unset to ours", () => {
    const teamFor = (env: Record<string, string>) =>
      spawnSync(
        "sh",
        ["-c", 'TEAM_ID_DEFAULT=MU9G7XKJUL; printf "[%s]" "${ATOMIC_AGENT_TEAM_ID-$TEAM_ID_DEFAULT}"'],
        { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
      ).stdout;
    expect(teamFor({})).toBe("[MU9G7XKJUL]");
    expect(teamFor({ ATOMIC_AGENT_TEAM_ID: "" })).toBe("[]");
    expect(teamFor({ ATOMIC_AGENT_TEAM_ID: "ABCDE12345" })).toBe("[ABCDE12345]");
  });

  it("runs the pin on every macOS path, including a --verify timeout or skip", () => {
    const fn = extractFunction("verify_signature");
    // once when the check is switched off, once after a timeout, once after a pass
    expect(fn.split('verify_team_id "$_vs_file"').length - 1).toBe(3);
    const skip = fn.indexOf('if [ "$VERIFY_TIMEOUT" -le 0 ]; then');
    expect(fn.slice(skip, fn.indexOf("return 0", skip))).toContain("verify_team_id");
    const timeout = fn.indexOf("was skipped.");
    expect(fn.slice(timeout, fn.indexOf("return 0", timeout))).toContain("verify_team_id");
  });

  it("accepts the expected Team ID", () => {
    expect(run("TeamIdentifier=MU9G7XKJUL", "MU9G7XKJUL").status).toBe(0);
  });

  it("refuses a binary signed by another team", () => {
    const res = run("TeamIdentifier=ABCDE12345", "MU9G7XKJUL");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("ABCDE12345");
  });

  it("refuses an ad-hoc or unsigned binary when a Team ID is expected", () => {
    for (const line of ["TeamIdentifier=not set", "Signature=adhoc", "code object is not signed at all"]) {
      const res = run(line, "MU9G7XKJUL");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("no Apple Team ID");
    }
  });

  it("does not pin when no Team ID is expected (ATOMIC_AGENT_TEAM_ID='' or a fork)", () => {
    expect(run("TeamIdentifier=ABCDE12345", "").status).toBe(0);
    expect(run("Signature=adhoc", "").status).toBe(0);
    expect(run("TeamIdentifier=not set", "").status).toBe(0);
  });
});
