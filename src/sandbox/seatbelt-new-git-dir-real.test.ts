import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCommandJob } from "./command-job.js";
import { buildOsSandboxPolicy, wrapWithOsSandbox } from "./os-sandbox.js";

/**
 * ATO-2471, review round 3, on the real macOS sandbox: the review's two
 * attacks, and the ordinary git commands that must keep working.
 */

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", [...ID, ...args], { cwd, encoding: "utf8", env: gitEnv });
const ok = (cwd: string, ...args: string[]): string => {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

async function runIn(work: string, script: string): Promise<void> {
  const p = buildOsSandboxPolicy({ workspaceRoots: [work], network: true });
  const env = "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; G='git -c user.name=t -c user.email=t@t'; ";
  const w = wrapWithOsSandbox("/bin/sh", ["-c", env + script], p);
  if (!w.ok) throw new Error(w.reason);
  const job = startCommandJob(w.command, w.args, { cwd: work });
  expect(await job.waitFor(30_000)).toBe("exited");
}

/** A repo whose range cherry-pick of `b` stops on a conflict, so `.git/sequencer` exists. */
function stoppedCherryPick(repo: string): void {
  ok(repo, "init", "-q", ".");
  const commit = (file: string, text: string, msg: string) => {
    spawnSync("/bin/sh", ["-c", `echo ${text} > ${file}`], { cwd: repo });
    ok(repo, "add", file);
    ok(repo, "commit", "-qm", msg);
  };
  commit("f", "a", "a");
  ok(repo, "checkout", "-qb", "b");
  commit("f", "b", "b");
  commit("g", "c", "c");
  ok(repo, "checkout", "-q", "main");
  commit("f", "m", "m");
  expect(git(repo, "cherry-pick", "b~1", "b").status).not.toBe(0);
  expect(existsSync(join(repo, ".git/sequencer/todo"))).toBe(true);
}

const real = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && spawnSync("git", ["--version"]).status === 0;
describe.skipIf(!real)("review round 3 on the real sandbox (macOS)", () => {
  let base = "";
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-r3-")));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("F1991-R3.1: refuses the sequencer's opts, so --continue runs no strategy of the command's", async () => {
    stoppedCherryPick(base);
    await runIn(
      base,
      [
        "printf '[options]\\n\\tstrategy = x/../evil\\n' > .git/sequencer/opts",
        "mv .git/sequencer s",
        "rm -rf .git/sequencer",
        "mkdir -p git-merge-x && printf '#!/bin/sh\\ntouch PWN\\n' > evil && chmod +x evil",
        "echo ok > note.txt",
      ].join("; "),
    );
    expect(existsSync(join(base, "note.txt"))).toBe(true);
    expect(existsSync(join(base, ".git/sequencer/opts"))).toBe(false);
    expect(existsSync(join(base, "s"))).toBe(false);
    expect(readFileSync(join(base, ".git/sequencer/todo"), "utf8")).toContain("pick");
  });

  it("F1991-R3.2: refuses a new git folder, made in place or moved out of .git", async () => {
    ok(base, "init", "-q", ".");
    ok(base, "commit", "-q", "--allow-empty", "-m", "a");
    await runIn(
      base,
      [
        "mkdir -p src/objects src/refs/heads",
        "printf 'ref: refs/heads/main\\n' > src/HEAD",
        "ln -s ../.git/HEAD src/HEAD",
        "printf '[core]\\n\\tworktree = ..\\n\\tfsmonitor = \"touch PWN\"\\n' > src/config",
        "mkdir -p .git/refs/x && printf 'ref: refs/heads/main\\n' > .git/refs/x/HEAD; mv .git/refs/x moved",
        "mv .git/logs moved2",
        "echo ok > note.txt",
      ].join("; "),
    );
    expect(existsSync(join(base, "note.txt"))).toBe(true);
    expect(existsSync(join(base, "src/HEAD"))).toBe(false);
    expect(existsSync(join(base, "moved"))).toBe(false);
    expect(existsSync(join(base, "moved2"))).toBe(false);
    // Outside the sandbox `src` is no repo of its own, so no fsmonitor runs.
    git(join(base, "src"), "status");
    expect(existsSync(join(base, "src/PWN"))).toBe(false);
    expect(existsSync(join(base, "PWN"))).toBe(false);
  });

  it("keeps ordinary git working: branches, a single cherry-pick, stash, pack-refs", async () => {
    ok(base, "init", "-q", ".");
    ok(base, "commit", "-q", "--allow-empty", "-m", "a");
    await runIn(
      base,
      [
        "set -e",
        "$G checkout -qb feature/x && echo b > b && $G add b && $G commit -qm b && $G checkout -q main",
        "$G cherry-pick feature/x >/dev/null",
        "$G branch -qD feature/x && $G branch feature",
        "echo c >> b && $G stash -q && $G stash pop -q",
        "$G pack-refs --all",
      ].join("; "),
    );
    expect(ok(base, "log", "--format=%s", "main").split("\n").filter(Boolean)).toEqual(["b", "a"]);
    expect(ok(base, "branch", "--format=%(refname:short)").split("\n").filter(Boolean)).toEqual(["feature", "main"]);
  });
});
