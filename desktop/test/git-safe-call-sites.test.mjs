// ATO-2532 review round 1: real-git tests for the call sites behind the
// hardened prefix (main/git-safe-args.ts), against the built output.
// Run: npm run build && npm run test:unit
// Each test plants a program in the repo's own config that writes a
// marker, checks that plain git runs it (so the setup is real), then
// checks that the desktop call does not.
//  - F1979.2: the @file index (file-mentions.ts listGitFiles) with a
//    core.fsmonitor program, and chat worktrees (chat-worktree-ipc.ts
//    gitExecWith) with a post-checkout hook.
// `@diff` and `@git:N` moved into the agent with ATO-2472 (#2046); their
// real-git checks (F1979.1 format.pretty, R2-1979.A submodule diff.external)
// live in src/mentions/mention-git.test.ts.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../out/main/file-mentions.js");
const W = require("../out/main/chat-worktree-ipc.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(tag) {
  const d = mkdtempSync(join(tmpdir(), `aa-gitsite-${tag}-`));
  dirs.push(d);
  return d;
}

function hasGit() {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const skip = process.platform === "win32" || !hasGit();

function git(cwd, args, input) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** A one-commit repo plus a marker path and a program that touches it. */
function repoWithProgram(tag) {
  const repo = tmp(`repo-${tag}`);
  const marker = join(tmp(`out-${tag}`), "ran");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "T"]);
  git(repo, ["config", "user.email", "t@example.test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const program = join(tmp(`prog-${tag}`), "prog.sh");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(program, 0o755);
  return { repo, marker, program };
}

test("F1979.2: the @file index does not run the repo's core.fsmonitor", { skip }, async () => {
  const plain = repoWithProgram("fsm-plain");
  git(plain.repo, ["config", "core.fsmonitor", plain.program]);
  git(plain.repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  assert.equal(existsSync(plain.marker), true, "plain ls-files runs the planted fsmonitor (the setup is real)");

  const guarded = repoWithProgram("fsm-guarded");
  git(guarded.repo, ["config", "core.fsmonitor", guarded.program]);
  const files = await F.listGitFiles(guarded.repo, { ...F.DEFAULT_FILE_INDEX_LIMITS, budgetMs: 1_000 });
  assert.ok(files.includes("a.txt"));
  assert.equal(existsSync(guarded.marker), false);
});

test("F1979.2: a chat worktree does not run the repo's post-checkout hook", { skip }, async () => {
  const hook = (r) => {
    const hooks = join(r.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${r.marker}'\nexit 0\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
  };
  const plain = repoWithProgram("hook-plain");
  hook(plain);
  git(plain.repo, ["worktree", "add", "-q", "--detach", join(tmp("wt"), "w"), "HEAD"]);
  assert.equal(existsSync(plain.marker), true, "plain git runs the planted hook (the setup is real)");

  const guarded = repoWithProgram("hook-guarded");
  hook(guarded);
  const exec = W.gitExecWith(() => process.env);
  const res = await exec(["worktree", "add", "-q", "--detach", join(tmp("wt"), "w"), "HEAD"], guarded.repo);
  assert.equal(res?.code, 0, res?.stderr);
  assert.equal(existsSync(guarded.marker), false);
});
