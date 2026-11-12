import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * install.sh pins the Apple Team ID of a signed macOS binary (ATO-760):
 * a valid signature from someone else's Developer ID is refused, an ad-hoc
 * signature (no Team ID) still installs. The function is cut out of the
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
    expect(script).toContain('EXPECTED_TEAM_ID="${ATOMIC_AGENT_TEAM_ID:-$TEAM_ID_DEFAULT}"');
    expect(script).toContain('EXPECTED_TEAM_ID="${ATOMIC_AGENT_TEAM_ID:-}"');
    expect(extractFunction("verify_signature")).toContain('verify_team_id "$_vs_file"');
  });

  it("accepts the expected Team ID", () => {
    expect(run("TeamIdentifier=MU9G7XKJUL", "MU9G7XKJUL").status).toBe(0);
  });

  it("refuses a binary signed by another team", () => {
    const res = run("TeamIdentifier=ABCDE12345", "MU9G7XKJUL");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("ABCDE12345");
  });

  it("lets an ad-hoc signature through (no Team ID to compare)", () => {
    expect(run("TeamIdentifier=not set", "MU9G7XKJUL").status).toBe(0);
    expect(run("Signature=adhoc", "MU9G7XKJUL").status).toBe(0);
  });

  it("does not pin when no Team ID is expected (a fork)", () => {
    expect(run("TeamIdentifier=ABCDE12345", "").status).toBe(0);
  });
});
