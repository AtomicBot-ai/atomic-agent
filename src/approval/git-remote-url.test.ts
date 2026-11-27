import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitRemoteUrl, gitRemoteUrls, parseGitConfig } from "./git-remote-url.js";

describe("gitRemoteUrl (ATO-2116)", () => {
  let root: string;
  const noGlobal = { globalConfigPaths: [] as string[], systemConfigPaths: [] as string[], env: {} };

  function repo(config: string, head = "ref: refs/heads/main\n"): string {
    const dir = join(root, "repo");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), config);
    writeFileSync(join(dir, ".git", "HEAD"), head);
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-remote-url-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a named remote's url, from a subfolder too", () => {
    const dir = repo('[remote "origin"]\n\turl = git@github.com:org/repo.git\n');
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    expect(gitRemoteUrl(dir, "origin", noGlobal)).toBe("git@github.com:org/repo.git");
    expect(gitRemoteUrl(join(dir, "src", "deep"), "origin", noGlobal)).toBe("git@github.com:org/repo.git");
    expect(gitRemoteUrl(dir, "upstream", noGlobal)).toBeNull();
  });

  it("prefers pushurl, and finds the default remote from the branch", () => {
    const dir = repo(
      [
        '[remote "origin"]',
        "  url = https://github.com/org/repo.git",
        '[remote "fork"]',
        "  url = https://github.com/me/repo.git",
        "  pushurl = https://push.example.com/me/repo.git",
        '[branch "main"]',
        "  remote = fork",
        "",
      ].join("\n"),
    );
    expect(gitRemoteUrl(dir, null, noGlobal)).toBe("https://push.example.com/me/repo.git");
    expect(gitRemoteUrl(dir, "origin", noGlobal)).toBe("https://github.com/org/repo.git");
  });

  // Review round 1 (F2105.1): only the last pushurl was read, but `git
  // push` sends to each of them (or to each url when there is none).
  it("reads every pushurl of a remote, else every url", () => {
    const dir = repo(
      [
        '[remote "origin"]',
        "  url = https://github.com/org/repo.git",
        "  pushurl = https://evil.example/x.git",
        "  pushurl = https://github.com/org/repo.git",
        '[remote "mirror"]',
        "  url = https://github.com/org/repo.git",
        "  url = https://evil.example/y.git",
        "",
      ].join("\n"),
    );
    expect(gitRemoteUrls(dir, "origin", noGlobal)).toEqual([
      "https://evil.example/x.git",
      "https://github.com/org/repo.git",
    ]);
    expect(gitRemoteUrls(dir, "mirror", noGlobal)).toEqual([
      "https://github.com/org/repo.git",
      "https://evil.example/y.git",
    ]);
    expect(gitRemoteUrls(dir, "upstream", noGlobal)).toBeNull();
  });

  it("falls back to origin when nothing names a push remote", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n', "0123abcd\n");
    expect(gitRemoteUrl(dir, null, noGlobal)).toBe("https://github.com/org/repo.git");
  });

  // Review round 2 (F2105-R2.2): rewrites are applied as git applies
  // them, from every config level, rather than giving up.
  it("applies insteadOf and pushInsteadOf, here or in the global config, and gives up on an include", () => {
    const rewrite = repo(
      '[remote "origin"]\n  url = https://github.com/org/repo.git\n[url "https://evil.example/"]\n  pushInsteadOf = https://github.com/\n',
    );
    expect(gitRemoteUrl(rewrite, "origin", noGlobal)).toBe("https://evil.example/org/repo.git");
    rmSync(join(root, "repo"), { recursive: true, force: true });

    const included = repo('[include]\n  path = other.cfg\n[remote "origin"]\n  url = https://github.com/o/r\n');
    expect(gitRemoteUrl(included, "origin", noGlobal)).toBeNull();
    rmSync(join(root, "repo"), { recursive: true, force: true });

    const plain = repo('[remote "origin"]\n  url = https://github.com/o/r\n  pushurl = https://github.com/o/p\n');
    const global = join(root, "gitconfig");
    writeFileSync(
      global,
      '[url "git@evil.example:"]\n  insteadOf = https://github.com/\n[url "https://other.example/"]\n  pushInsteadOf = https://github.com/\n',
    );
    // A pushurl takes insteadOf, never pushInsteadOf.
    expect(gitRemoteUrl(plain, "origin", { ...noGlobal, globalConfigPaths: [global] })).toBe("git@evil.example:o/p");
  });

  it.each([
    ["the global config", "globalConfigPaths"],
    ["the system config", "systemConfigPaths"],
  ] as const)("reads a pushurl set in %s (git config --global remote.origin.pushurl)", (_where, seam) => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n');
    const level = join(root, "level.cfg");
    writeFileSync(level, '[remote "origin"]\n  pushurl = https://evil.example/x.git\n[remote]\n  pushDefault = origin\n');
    expect(gitRemoteUrls(dir, "origin", { ...noGlobal, [seam]: [level] })).toEqual(["https://evil.example/x.git"]);
    expect(gitRemoteUrls(dir, null, { ...noGlobal, [seam]: [level] })).toEqual(["https://evil.example/x.git"]);
  });

  it("reads the global config from GIT_CONFIG_GLOBAL, and gives up on config passed in the environment", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n');
    const level = join(root, "override.cfg");
    writeFileSync(level, '[remote "origin"]\n  pushurl = https://evil.example/x.git\n');
    expect(gitRemoteUrls(dir, "origin", { systemConfigPaths: [], env: { GIT_CONFIG_GLOBAL: level } })).toEqual([
      "https://evil.example/x.git",
    ]);
    expect(gitRemoteUrls(dir, "origin", { ...noGlobal, env: { GIT_CONFIG_COUNT: "1" } })).toBeNull();
    expect(gitRemoteUrls(dir, "origin", { ...noGlobal, env: { GIT_CONFIG_PARAMETERS: "'x=y'" } })).toBeNull();
  });

  // Review round 2 (F2105-R2.1): `git config push.recurseSubmodules
  // on-demand` then a plain `git push` also pushed the submodule to its
  // own remote.
  it.each([
    "[push]\n  recurseSubmodules = on-demand\n",
    "[push]\n  recurseSubmodules = check\n",
    "[submodule]\n  recurse = true\n",
  ])("gives up when the push recurses into submodules: %j", (extra) => {
    const dir = repo(`[remote "origin"]\n  url = https://github.com/org/repo.git\n${extra}`);
    expect(gitRemoteUrls(dir, "origin", noGlobal)).toBeNull();
    const global = join(root, "global.cfg");
    rmSync(join(root, "repo"), { recursive: true, force: true });
    const plain = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n');
    writeFileSync(global, extra);
    expect(gitRemoteUrls(plain, "origin", { ...noGlobal, globalConfigPaths: [global] })).toBeNull();
  });

  it("reads a push that does not recurse into submodules", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n[push]\n  recurseSubmodules = no\n[submodule]\n  recurse = true\n');
    expect(gitRemoteUrls(dir, "origin", noGlobal)).toEqual(["https://github.com/org/repo.git"]);
  });

  it("follows a worktree's .git file to the common config", () => {
    const main = repo('[remote "origin"]\n  url = https://gitlab.example.com/o/r.git\n');
    const wtGitDir = join(main, ".git", "worktrees", "wt");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/feature\n");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitDir}\n`);
    expect(gitRemoteUrl(wt, null, noGlobal)).toBe("https://gitlab.example.com/o/r.git");
  });

  it("is null outside a repository", () => {
    expect(gitRemoteUrl(root, "origin", noGlobal)).toBeNull();
  });
});

describe("parseGitConfig", () => {
  it("keeps subsection case and drops comments", () => {
    const config = parseGitConfig('[Remote "Origin"]\n  URL = "https://x.io/r" # note\n; c\n');
    expect(config.get("remote.Origin.url")).toEqual(["https://x.io/r"]);
  });
});
