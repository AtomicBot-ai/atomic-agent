import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dotGitFileTarget, gitDataDirs } from "./git-dirs.js";
import { findRepo } from "./git-hooks-path.js";
import { buildOsSandboxPolicy, buildSeatbeltProfile } from "./os-sandbox.js";
import {
  SEATBELT_GIT_PATTERN,
  SEATBELT_GIT_WRITABLE_PATTERNS,
  SEATBELT_PROTECTED_PATTERNS,
} from "./sandbox-protected-paths.js";
import {
  SEATBELT_GIT_HEAD_FOLDER_PATTERNS,
  SEATBELT_GIT_HEAD_PATTERN,
  seatbeltNewGitDirRules,
} from "./seatbelt-new-git-dir.js";

/**
 * ATO-2471, review round 3: the sequencer state, a git folder the command
 * makes itself, and the low items of the same functions.
 */

const test = (re: string, path: string) => new RegExp(re).test(path);
// The two `.git` rules of `seatbeltProtectedWriteRule`, as in its own test.
const protectedOnMac = (path: string) =>
  SEATBELT_PROTECTED_PATTERNS.some((re) => test(re, path)) ||
  (test(SEATBELT_GIT_PATTERN, path) && !SEATBELT_GIT_WRITABLE_PATTERNS.some((re) => test(re, path)));
// The `HEAD` rule of `seatbeltNewGitDirRules`, without `-D` folders.
const headDenied = (path: string) => test("/HEAD$", path) && !test(SEATBELT_GIT_HEAD_PATTERN, path);
const folderLocked = (path: string) => SEATBELT_GIT_HEAD_FOLDER_PATTERNS.some((re) => test(re, path));

describe("F1991-R3.1: the sequencer state", () => {
  it("is read-only: its opts names a merge strategy that --continue runs", () => {
    for (const path of [
      "/w/.git/sequencer",
      "/w/.git/sequencer/opts",
      "/w/.git/sequencer/opts.lock",
      "/w/.git/sequencer/todo",
      "/w/.git/sequencer/head",
      "/w/.git/worktrees/wt/sequencer/opts",
      "/w/.git/modules/sub/sequencer/opts",
    ]) {
      expect(protectedOnMac(path), path).toBe(true);
    }
  });

  it("is not a data folder of a git folder with another name", () => {
    expect(gitDataDirs("/w/.bare")).not.toContain("/w/.bare/sequencer");
    expect(gitDataDirs("/w/.bare")).toContain("/w/.bare/refs");
  });
});

describe("Low items of the same rules", () => {
  it("keep a submodule's hooks read-only when its name ends like a data folder (lib/refs)", () => {
    for (const path of [
      "/w/.git/modules/lib/refs/hooks/pre-commit",
      "/w/.git/modules/lib/refs/hooks",
      "/w/.git/modules/lib/logs/config",
      "/w/.git/modules/a/objects/commondir",
      "/w/.git/modules/lib/refs/rebase-merge/git-rebase-todo",
    ]) {
      expect(protectedOnMac(path), path).toBe(true);
    }
    // The submodule's own data stays writable.
    expect(protectedOnMac("/w/.git/modules/lib/refs/refs/heads/main")).toBe(false);
    expect(protectedOnMac("/w/.git/modules/lib/objects/info/packs")).toBe(false);
  });

  it("let git gc and pack-refs write packed-refs.new", () => {
    expect(protectedOnMac("/w/.git/packed-refs.new")).toBe(false);
  });

  it("read a .git file the way git does: spaces kept, `gitdir: ` exact", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-gitfile-")));
    try {
      mkdirSync(join(base, "w"));
      writeFileSync(join(base, "w/.git"), "gitdir: ./g \n");
      expect(dotGitFileTarget(join(base, "w/.git"))).toBe(join(base, "w/g "));
      expect(findRepo(join(base, "w"))?.gitDir).toBe(join(base, "w/g "));
      writeFileSync(join(base, "w/.git"), "gitdir:./g\n");
      expect(dotGitFileTarget(join(base, "w/.git"))).toBeNull();
      writeFileSync(join(base, "w/.git"), "x\ngitdir: ./g\n");
      expect(dotGitFileTarget(join(base, "w/.git"))).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("list a submodule's data folders in a git folder with another name", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-gitmods-")));
    try {
      mkdirSync(join(base, ".bare/modules/sub"), { recursive: true });
      writeFileSync(join(base, ".bare/modules/sub/HEAD"), "ref: refs/heads/main\n");
      const data = gitDataDirs(join(base, ".bare"));
      expect(data).toContain(join(base, ".bare/modules/sub/objects"));
      expect(data).toContain(join(base, ".bare/modules/sub/refs"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("F1991-R3.2: no new git folder", () => {
  it("allow HEAD only where git keeps one", () => {
    for (const path of [
      "/w/src/HEAD",
      "/w/HEAD",
      "/tmp/x/HEAD",
      "/w/.git/refs/x/HEAD",
      "/w/.git/objects/ab/HEAD",
      "/w/.git/logs/refs/heads/HEAD",
    ]) {
      expect(headDenied(path), path).toBe(true);
    }
    for (const path of [
      "/w/.git/HEAD",
      "/w/.git/logs/HEAD",
      "/w/.git/refs/remotes/origin/HEAD",
      "/w/.git/logs/refs/remotes/origin/HEAD",
      "/w/.git/worktrees/wt/HEAD",
      "/w/.git/worktrees/wt/logs/HEAD",
      "/w/.git/modules/sub/HEAD",
      "/w/.git/ORIG_HEAD",
      "/w/src/FETCH_HEAD",
      "/w/src/HEAD.md",
    ]) {
      expect(headDenied(path), path).toBe(false);
    }
  });

  it("lock the folders that hold such a HEAD, not the other ref folders", () => {
    for (const path of [
      "/w/.git/logs",
      "/w/.git/refs",
      "/w/.git/logs/refs",
      "/w/.git/refs/remotes",
      "/w/.git/refs/remotes/origin",
      "/w/.git/logs/refs/remotes/a/b",
      "/w/.git/modules/lib/refs/x",
    ]) {
      expect(folderLocked(path), path).toBe(true);
    }
    for (const path of ["/w/.git/refs/heads/feature", "/w/.git/logs/refs/heads/feature", "/w/.git/objects/ab", "/w/src"]) {
      expect(folderLocked(path), path).toBe(false);
    }
  });

  it("go into the profile after every rule that allows a write, with the other git folders", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-newgit-")));
    try {
      for (const d of [".bare/objects", ".bare/refs"]) mkdirSync(join(base, d), { recursive: true });
      writeFileSync(join(base, ".bare/HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(base, ".bare/config"), "[core]\n\tbare = true\n");
      const lines = buildSeatbeltProfile(buildOsSandboxPolicy({ workspaceRoots: [base], network: true })).split("\n");
      const [head, folders] = seatbeltNewGitDirRules(["G0"]);
      const lastAllow = Math.max(...lines.map((l, i) => (/^\(allow [^)]*file-write\*/.test(l) ? i : -1)));
      expect(lines.indexOf(head as string)).toBeGreaterThan(lastAllow);
      expect(lines.indexOf(folders as string)).toBeGreaterThan(lastAllow);
      expect(head).toContain('(subpath (param "G0"))');
      expect(folders).toContain("(vnode-type DIRECTORY)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
