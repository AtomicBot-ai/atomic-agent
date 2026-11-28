import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitRemoteUrl, gitRemoteUrls, parseGitConfig } from "./git-remote-url.js";

/** A version 2 index with one entry of `mode` at `path`. */
function indexWith(mode: number, path: string): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const entry = Buffer.alloc((62 + path.length + 8) & ~7);
  entry.writeUInt32BE(mode, 24);
  entry.writeUInt16BE(path.length, 60);
  entry.write(path, 62, "latin1");
  return Buffer.concat([header, entry, Buffer.alloc(20)]);
}

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

  // Review round 3 (test mutation): the default system path list, not a seam.
  it("reads the system config from GIT_CONFIG_SYSTEM unless GIT_CONFIG_NOSYSTEM is set", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n');
    const level = join(root, "system.cfg");
    writeFileSync(level, '[remote "origin"]\n  pushurl = https://evil.example/x.git\n');
    expect(gitRemoteUrls(dir, "origin", { globalConfigPaths: [], env: { GIT_CONFIG_SYSTEM: level } })).toEqual([
      "https://evil.example/x.git",
    ]);
    const off = { GIT_CONFIG_SYSTEM: level, GIT_CONFIG_NOSYSTEM: "1" };
    expect(gitRemoteUrls(dir, "origin", { globalConfigPaths: [], env: off })).toEqual(["https://github.com/org/repo.git"]);
  });

  // Review round 2 (F2105-R2.1): `git config push.recurseSubmodules
  // on-demand` then a plain `git push` also pushed the submodule to its
  // own remote. Review round 3 (F2105-R3.1): the setting read last wins,
  // and `submodule.recurse` is a git bool (checked against git 2.39).
  it.each([
    "[push]\n  recurseSubmodules = on-demand\n",
    "[push]\n  recurseSubmodules = only\n",
    "[submodule]\n  recurse = true\n",
    "[submodule]\n  recurse = 2\n",
    "[submodule]\n  recurse = 0x1\n",
    "[submodule]\n  recurse\n",
    "[push]\n  recurseSubmodules = no\n[submodule]\n  recurse = true\n",
  ])("gives up when the push recurses into submodules: %j", (extra) => {
    const dir = repo(`[remote "origin"]\n  url = https://github.com/org/repo.git\n${extra}`);
    writeFileSync(join(dir, ".gitmodules"), '[submodule "sub"]\n  path = sub\n  url = https://evil.example/s.git\n');
    expect(gitRemoteUrls(dir, "origin", noGlobal)).toBeNull();
    const global = join(root, "global.cfg");
    rmSync(join(root, "repo"), { recursive: true, force: true });
    const plain = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n');
    writeFileSync(join(plain, ".gitmodules"), "");
    writeFileSync(global, extra);
    expect(gitRemoteUrls(plain, "origin", { ...noGlobal, globalConfigPaths: [global] })).toBeNull();
  });

  it("gives up on a global push.recurseSubmodules=no that the repository's submodule.recurse overrides", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n[submodule]\n  recurse = true\n');
    writeFileSync(join(dir, ".gitmodules"), "");
    const global = join(root, "global.cfg");
    writeFileSync(global, "[push]\n  recurseSubmodules = no\n");
    expect(gitRemoteUrls(dir, "origin", { ...noGlobal, globalConfigPaths: [global] })).toBeNull();
  });

  it.each([
    "[submodule]\n  recurse = true\n[push]\n  recurseSubmodules = no\n",
    "[push]\n  recurseSubmodules = on-demand\n[submodule]\n  recurse = false\n",
    "[push]\n  recurseSubmodules = check\n",
    "[submodule]\n  recurse = 0\n",
  ])("reads a push that does not recurse into submodules: %j", (extra) => {
    const dir = repo(`[remote "origin"]\n  url = https://github.com/org/repo.git\n${extra}`);
    writeFileSync(join(dir, ".gitmodules"), "");
    expect(gitRemoteUrls(dir, "origin", noGlobal)).toEqual(["https://github.com/org/repo.git"]);
  });

  // Review round 3 (FALSE_BLOCK): a global submodule.recurse=true held
  // every push, even in a repository with no submodules.
  it("reads an ordinary push in a repository without submodules though submodule.recurse is on", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n');
    const global = join(root, "global.cfg");
    writeFileSync(global, "[submodule]\n  recurse = true\n");
    const options = { ...noGlobal, globalConfigPaths: [global] };
    expect(gitRemoteUrls(dir, "origin", options)).toEqual(["https://github.com/org/repo.git"]);
    // A regular file in the index is no submodule.
    writeFileSync(join(dir, ".git", "index"), indexWith(0o100644, "README.md"));
    expect(gitRemoteUrls(dir, "origin", options)).toEqual(["https://github.com/org/repo.git"]);
    // A submodule in the index, or an absorbed one, is.
    writeFileSync(join(dir, ".git", "index"), indexWith(0o160000, "sub"));
    expect(gitRemoteUrls(dir, "origin", options)).toBeNull();
    rmSync(join(dir, ".git", "index"));
    mkdirSync(join(dir, ".git", "modules", "sub"), { recursive: true });
    expect(gitRemoteUrls(dir, "origin", options)).toBeNull();
  });

  // Review round 3 (F2105-R3.4): git reads config.worktree only with
  // extensions.worktreeConfig on, so a decoy one changed nothing.
  it("reads config.worktree only when extensions.worktreeConfig is on", () => {
    const base = '[remote "origin"]\n  url = https://evil.example/r.git\n[remote "gh"]\n  url = https://github.com/o/r.git\n';
    const dir = repo(base);
    writeFileSync(join(dir, ".git", "config.worktree"), "[remote]\n  pushDefault = gh\n");
    expect(gitRemoteUrls(dir, null, noGlobal)).toEqual(["https://evil.example/r.git"]);
    writeFileSync(join(dir, ".git", "config"), `${base}[extensions]\n  worktreeConfig = true\n`);
    expect(gitRemoteUrls(dir, null, noGlobal)).toEqual(["https://github.com/o/r.git"]);
  });

  // Review round 3 (F2105-R3.3): `git push <url>` takes the rewrites too,
  // and a remote may be named like a URL (checked against git 2.39).
  it("applies the rewrites to a URL or a path given as the remote", () => {
    const dir = repo('[remote "https://github.com/c/d"]\n  url = https://evil.example/d.git\n');
    const global = join(root, "global.cfg");
    writeFileSync(global, '[url "https://evil.example/"]\n  pushInsteadOf = https://github.com/a/\n  pushInsteadOf = ../mirror\n');
    const options = { ...noGlobal, globalConfigPaths: [global] };
    expect(gitRemoteUrls(dir, "https://github.com/a/b", options)).toEqual(["https://evil.example/b"]);
    expect(gitRemoteUrls(dir, "../mirror.git", options)).toEqual(["https://evil.example/.git"]);
    expect(gitRemoteUrls(dir, "https://github.com/c/d", options)).toEqual(["https://evil.example/d.git"]);
    expect(gitRemoteUrls(dir, "https://gitlab.com/x/y", options)).toEqual(["https://gitlab.com/x/y"]);
    expect(gitRemoteUrls(dir, "upstream", options)).toBeNull();
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
