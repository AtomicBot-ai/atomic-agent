import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GIT_HOOK_NAMES, findRepo, gitHookTargets, parseGitConfig } from "./git-hooks-path.js";
import { buildOsSandboxPolicy, buildSeatbeltProfile, wrapWithOsSandbox } from "./os-sandbox.js";

/**
 * ATO-2471, review F1991.2: a repo whose `core.hooksPath` names a
 * work-tree folder runs its hooks from there, so that folder (and any
 * config file the git config includes) stays read-only too.
 */

describe("parseGitConfig", () => {
  it("reads sections, keys on the header line, quotes and comments", () => {
    const text = [
      "[core] hooksPath = tools/hooks",
      "[CORE]",
      '\tHooksPath = "a b" ; comment',
      '[includeIf "gitdir:~/work/"]',
      "\tpath = ~/work.gitconfig # comment",
      "[include]",
      "\tpath=../extra.cfg",
      "# [core] hooksPath = commented",
      "\tbare",
    ].join("\n");
    expect(parseGitConfig(text)).toEqual([
      { section: "core", key: "hookspath", value: "tools/hooks" },
      { section: "core", key: "hookspath", value: "a b" },
      { section: "includeif", key: "path", value: "~/work.gitconfig" },
      { section: "include", key: "path", value: "../extra.cfg" },
      { section: "include", key: "bare", value: "" },
    ]);
  });
});

describe("gitHookTargets", () => {
  let base = "";
  let repo = "";
  let home = "";
  const env = { GIT_CONFIG_SYSTEM: "/nonexistent/gitconfig" };
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-hooks-")));
    repo = join(base, "repo");
    home = join(base, "home");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(home);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists a work-tree hooksPath folder and the included files", () => {
    writeFileSync(
      join(repo, ".git/config"),
      "[core]\n\thooksPath = tools/hooks\n[include]\n\tpath = ../local.gitconfig\n",
    );
    writeFileSync(join(repo, "local.gitconfig"), "[core]\n\thooksPath = /opt/hooks\n");
    const found = gitHookTargets({ workRoots: [repo], home, env });
    expect(found).toEqual(
      expect.arrayContaining([join(repo, "tools/hooks"), join(repo, "local.gitconfig"), "/opt/hooks"]),
    );
  });

  it("takes a relative global hooksPath from the top of the work tree", () => {
    writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = .hooks\n");
    expect(gitHookTargets({ workRoots: [join(repo, "src")], home, env })).toContain(join(repo, ".hooks"));
  });

  it("lists only the hook files when hooksPath is the working folder itself", () => {
    writeFileSync(join(repo, ".git/config"), "[core]\n\thooksPath = .\n");
    const found = gitHookTargets({ workRoots: [repo], home, env });
    expect(found).not.toContain(repo);
    expect(found).toContain(join(repo, "pre-commit"));
    expect(found).toHaveLength(GIT_HOOK_NAMES.length);
  });

  it("follows a worktree's `.git` file and commondir to the common config", () => {
    const wt = join(base, "wt");
    mkdirSync(join(repo, ".git/worktrees/wt"), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git/worktrees/wt")}\n`);
    writeFileSync(join(repo, ".git/worktrees/wt/commondir"), "../..\n");
    writeFileSync(join(repo, ".git/config"), "[core]\n\thooksPath = .husky/_\n");
    expect(findRepo(wt)).toEqual({ top: wt, gitDir: join(repo, ".git/worktrees/wt") });
    expect(gitHookTargets({ workRoots: [wt], home, env })).toContain(join(wt, ".husky/_"));
  });

  it("puts the folder into the policy, the Seatbelt profile and the bwrap binds", () => {
    mkdirSync(join(repo, "tools/hooks"), { recursive: true });
    writeFileSync(join(repo, ".git/config"), "[core]\n\thooksPath = tools/hooks\n");
    const p = buildOsSandboxPolicy({ workspaceRoots: [repo], network: true, home, tmp: join(base, "tmp") });
    const hooks = join(repo, "tools/hooks");
    const i = (p.protectedPaths ?? []).indexOf(hooks);
    expect(i).toBeGreaterThan(-1);
    expect(buildSeatbeltProfile(p)).toContain(`(subpath (param "P${i}"))`);
    const mac = wrapWithOsSandbox("ls", [], p, { platform: "darwin", seatbeltAvailable: true });
    if (!mac.ok) throw new Error(mac.reason);
    expect(mac.args).toContain(`P${i}=${hooks}`);
    const linux = wrapWithOsSandbox("ls", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!linux.ok) throw new Error(linux.reason);
    const ro = linux.args.findIndex((a, i) => a === "--ro-bind" && linux.args[i + 1] === hooks);
    expect(ro).toBeGreaterThan(-1);
  });
});
