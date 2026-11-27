// ATO-2532 review round 1: real-git tests for the call sites behind the
// hardened prefix (main/git-safe-args.ts), against the built output.
// Run: npm run build && npm run test:unit
// Each test plants a program in the repo's own config that writes a
// marker, checks that plain git runs it (so the setup is real), then
// checks that the desktop call does not.
//  - F1979.1: `@git:N` (mention-git.ts logArgs) with `format.pretty=%G?`,
//    a `gpg.program` and a signed commit.
//  - F1979.2: the @file index (file-mentions.ts listGitFiles) with a
//    core.fsmonitor program, and chat worktrees (chat-worktree-ipc.ts
//    gitExecWith) with a post-checkout hook.
//  - R2-1979.A (review round 2): `@diff` and `@git:N` in a repo with
//    `diff.submodule=diff` and a changed submodule whose own config sets
//    `diff.external`. git starts a child diff in the submodule, where
//    `--no-ext-diff` does not reach.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../out/main/mention-git.js");
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

/** Moves HEAD to a commit with a `gpgsig` header and asks for %G? via format.pretty. */
function plantSignedCommit({ repo, program }) {
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
  const body = [
    `tree ${tree}`,
    "author T <t@example.test> 1 +0000",
    "committer T <t@example.test> 1 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " abc",
    " -----END PGP SIGNATURE-----",
    "",
    "signed",
    "",
  ].join("\n");
  const commit = git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], body).trim();
  git(repo, ["update-ref", "HEAD", commit]);
  git(repo, ["config", "format.pretty", "%H %G?"]);
  git(repo, ["config", "gpg.program", program]);
}

test("@git:N asks for the medium format explicitly", () => {
  const args = G.logArgs(2);
  assert.ok(args.includes("--pretty=medium"));
  assert.ok(args.indexOf("--pretty=medium") < args.indexOf("--"));
});

test("F1979.1: @git:N does not run the repo's gpg.program through format.pretty", { skip }, async () => {
  const plain = repoWithProgram("gpg-plain");
  plantSignedCommit(plain);
  // The same argv without the explicit format: git verifies the signature.
  const withoutFormat = G.logArgs(1).filter((a) => a !== "--pretty=medium");
  try { git(plain.repo, [...G.GIT_SAFE_PREFIX, ...withoutFormat]); } catch { /* git may report the bad signature */ }
  assert.equal(existsSync(plain.marker), true, "the planted gpg.program runs without --pretty (the setup is real)");

  const guarded = repoWithProgram("gpg-guarded");
  plantSignedCommit(guarded);
  const out = await G.createRunGit()(guarded.repo, G.logArgs(1));
  assert.match(out.text, /^commit [0-9a-f]{40}/);
  assert.equal(existsSync(guarded.marker), false);
});

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

/**
 * A top repo with a submodule `sub` whose own config names `program` as
 * `diff.external`, the top config set to `diff.submodule=diff`, and the
 * submodule moved one commit past what the top repo records. With
 * `commit`, the move is also committed in the top repo (for `@git:N`).
 */
function repoWithSubmodule(tag, { commit = false } = {}) {
  const sub = repoWithProgram(`sub-${tag}`);
  const top = repoWithProgram(`top-${tag}`);
  git(top.repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.repo, "sub"]);
  git(top.repo, ["commit", "-q", "-m", "add sub"]);
  git(top.repo, ["config", "diff.submodule", "diff"]);
  const inner = join(top.repo, "sub");
  git(inner, ["config", "user.name", "T"]);
  git(inner, ["config", "user.email", "t@example.test"]);
  git(inner, ["config", "commit.gpgsign", "false"]);
  git(inner, ["config", "diff.external", top.program]);
  writeFileSync(join(inner, "a.txt"), "two\n");
  git(inner, ["commit", "-q", "-am", "move"]);
  if (commit) {
    git(top.repo, ["add", "sub"]);
    git(top.repo, ["commit", "-q", "-m", "bump sub"]);
  }
  return top;
}

const SUBMODULE_OPTS = new Set(["--submodule=short"]);
/** The prefix without `-c diff.submodule=short`. */
function prefixWithoutSubmoduleShort() {
  const out = [];
  for (let i = 0; i < G.GIT_SAFE_PREFIX.length; i++) {
    if (G.GIT_SAFE_PREFIX[i] === "-c" && G.GIT_SAFE_PREFIX[i + 1] === "diff.submodule=short") { i++; continue; }
    out.push(G.GIT_SAFE_PREFIX[i]);
  }
  return out;
}

for (const [name, args, commit] of [
  ["@diff", () => G.diffArgs(), false],
  ["@git:N", () => G.logArgs(1), true],
]) {
  test(`R2-1979.A: ${name} does not run a submodule's diff.external`, { skip }, async () => {
    // Setup is real: the round-1 argv (no --submodule=short, no
    // diff.submodule=short in the prefix) runs the submodule's program.
    const plain = repoWithSubmodule(`${name === "@diff" ? "d" : "l"}-plain`, { commit });
    const bare = args().filter((a) => !SUBMODULE_OPTS.has(a));
    try { git(plain.repo, [...prefixWithoutSubmoduleShort(), ...bare]); } catch { /* the program exits 1 */ }
    assert.equal(existsSync(plain.marker), true, "the round-1 argv runs the submodule's diff.external (the setup is real)");

    // The desktop call.
    const guarded = repoWithSubmodule(`${name === "@diff" ? "d" : "l"}-guarded`, { commit });
    const out = await G.createRunGit()(guarded.repo, args());
    assert.match(out.text, /Subproject commit [0-9a-f]{40}/);
    assert.equal(existsSync(guarded.marker), false);

    // Each half holds on its own: the argv flag without the prefix
    // option, and the prefix option without the argv flag.
    const flagOnly = repoWithSubmodule(`${name === "@diff" ? "d" : "l"}-flag`, { commit });
    try { git(flagOnly.repo, [...prefixWithoutSubmoduleShort(), ...args()]); } catch { /* checked below */ }
    assert.equal(existsSync(flagOnly.marker), false, "--submodule=short on the argv");
    const prefixOnly = repoWithSubmodule(`${name === "@diff" ? "d" : "l"}-prefix`, { commit });
    try { git(prefixOnly.repo, [...G.GIT_SAFE_PREFIX, ...bare]); } catch { /* checked below */ }
    assert.equal(existsSync(prefixOnly.marker), false, "diff.submodule=short in the safe prefix");
  });
}
