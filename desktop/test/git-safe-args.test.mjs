// ATO-2532: unit tests for main/git-safe-args.ts, against the built output.
// Run: npm run build && npm run test:unit
// A folder's own .git/config can name programs git runs by itself. These
// tests plant a core.fsmonitor program and a post-checkout hook that each
// write a marker file, check that plain git does run them (so the setup is
// real), then check that the same call behind gitSafeArgs() does not.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/git-safe-args.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(tag) {
  const d = mkdtempSync(join(tmpdir(), `aa-gitsafe-${tag}-`));
  dirs.push(d);
  return d;
}

function hasGit() {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const skip = process.platform === "win32" || !hasGit();

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** A repo with one commit whose config/hooks would write `marker` when run. */
function hostileRepo(kind) {
  const repo = tmp(`repo-${kind}`);
  const marker = join(tmp(`out-${kind}`), "ran");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "T"]);
  git(repo, ["config", "user.email", "t@example.test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const script = `#!/bin/sh\ntouch '${marker}'\nexit 0\n`;
  if (kind === "fsmonitor") {
    const prog = join(tmp("prog"), "fsmonitor.sh");
    writeFileSync(prog, script);
    chmodSync(prog, 0o755);
    git(repo, ["config", "core.fsmonitor", prog]);
  } else {
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-checkout"), script);
    chmodSync(join(hooks, "post-checkout"), 0o755);
  }
  return { repo, marker };
}

test("the null hooks path is /dev/null on macOS and Linux and NUL on Windows", () => {
  assert.equal(S.gitNullPath("darwin"), "/dev/null");
  assert.equal(S.gitNullPath("linux"), "/dev/null");
  assert.equal(S.gitNullPath("win32"), "NUL");
  assert.ok(S.gitSafeArgs("win32").includes("core.hooksPath=NUL"));
});

test("every option is a global one: -c pairs and -- flags only", () => {
  const args = S.gitSafeArgs("linux");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") { assert.match(args[i + 1], /^[a-z.]+=/i); i++; continue; }
    assert.match(args[i], /^--no-/);
  }
  for (const want of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "log.showSignature=false", "--no-optional-locks"]) {
    assert.ok(args.includes(want), want);
  }
});

test("a repo's core.fsmonitor program does not run behind gitSafeArgs", { skip }, () => {
  const plain = hostileRepo("fsmonitor");
  git(plain.repo, ["status", "--porcelain"]);
  assert.equal(existsSync(plain.marker), true, "plain git runs the planted fsmonitor (the setup is real)");

  const guarded = hostileRepo("fsmonitor");
  git(guarded.repo, [...S.gitSafeArgs(), "status", "--porcelain"]);
  git(guarded.repo, [...S.gitSafeArgs(), "diff", "HEAD"]);
  git(guarded.repo, [...S.gitSafeArgs(), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  assert.equal(existsSync(guarded.marker), false);
});

test("a repo's post-checkout hook does not run on worktree add behind gitSafeArgs", { skip }, () => {
  const plain = hostileRepo("hook");
  git(plain.repo, ["worktree", "add", "-q", "--detach", join(tmp("wt"), "w"), "HEAD"]);
  assert.equal(existsSync(plain.marker), true, "plain git runs the planted hook (the setup is real)");

  const guarded = hostileRepo("hook");
  git(guarded.repo, [...S.gitSafeArgs(), "worktree", "add", "-q", "--detach", join(tmp("wt"), "w"), "HEAD"]);
  assert.equal(existsSync(guarded.marker), false);
});
