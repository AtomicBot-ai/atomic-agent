import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitRemoteUrl, parseGitConfig } from "./git-remote-url.js";

describe("gitRemoteUrl (ATO-2116)", () => {
  let root: string;
  const noGlobal = { globalConfigPaths: [] as string[] };

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

  it("falls back to origin when nothing names a push remote", () => {
    const dir = repo('[remote "origin"]\n  url = https://github.com/org/repo.git\n', "0123abcd\n");
    expect(gitRemoteUrl(dir, null, noGlobal)).toBe("https://github.com/org/repo.git");
  });

  it("gives up on a URL rewrite or an include, here or in the global config", () => {
    const rewrite = repo(
      '[remote "origin"]\n  url = https://github.com/org/repo.git\n[url "https://evil.example/"]\n  pushInsteadOf = https://github.com/\n',
    );
    expect(gitRemoteUrl(rewrite, "origin", noGlobal)).toBeNull();
    rmSync(join(root, "repo"), { recursive: true, force: true });

    const included = repo('[include]\n  path = other.cfg\n[remote "origin"]\n  url = https://github.com/o/r\n');
    expect(gitRemoteUrl(included, "origin", noGlobal)).toBeNull();
    rmSync(join(root, "repo"), { recursive: true, force: true });

    const plain = repo('[remote "origin"]\n  url = https://github.com/o/r\n');
    const global = join(root, "gitconfig");
    writeFileSync(global, '[url "git@evil.example:"]\n  insteadOf = https://github.com/\n');
    expect(gitRemoteUrl(plain, "origin", { globalConfigPaths: [global] })).toBeNull();
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
