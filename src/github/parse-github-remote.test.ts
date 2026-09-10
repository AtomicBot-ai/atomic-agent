import { describe, expect, it } from "vitest";

import {
  formatRepoSlug,
  isGithubHttpsRemote,
  isGithubRemote,
  parseGithubRemote,
  parseRepoSlug,
} from "./parse-github-remote.js";

describe("parseGithubRemote", () => {
  it.each([
    "https://github.com/AtomicBot-ai/atomic-agent.git",
    "https://github.com/AtomicBot-ai/atomic-agent",
    "https://github.com/AtomicBot-ai/atomic-agent/",
    "http://github.com/AtomicBot-ai/atomic-agent.git",
    "https://user@github.com/AtomicBot-ai/atomic-agent.git",
    "git@github.com:AtomicBot-ai/atomic-agent.git",
    "git@github.com:AtomicBot-ai/atomic-agent",
    "ssh://git@github.com/AtomicBot-ai/atomic-agent.git",
    "git://github.com/AtomicBot-ai/atomic-agent.git",
    "  https://github.com/AtomicBot-ai/atomic-agent.git\n",
    "ssh://git@ssh.github.com:443/AtomicBot-ai/atomic-agent.git",
    "https://github.com:443/AtomicBot-ai/atomic-agent",
  ])("parses %s", (url) => {
    expect(parseGithubRemote(url)).toEqual({
      owner: "AtomicBot-ai",
      repo: "atomic-agent",
    });
  });

  it("refuses every other host rather than guessing", () => {
    // A GitHub token must never be attached to a push against one of these.
    expect(parseGithubRemote("https://gitlab.com/a/b.git")).toBeNull();
    expect(parseGithubRemote("git@bitbucket.org:a/b.git")).toBeNull();
    expect(parseGithubRemote("https://github.com.evil.io/a/b.git")).toBeNull();
    expect(parseGithubRemote("https://notgithub.com/a/b.git")).toBeNull();
    // Another host whose URL merely contains `@github.com:`.
    expect(
      parseGithubRemote("https://evil.example/x@github.com:a/b"),
    ).toBeNull();
    expect(parseGithubRemote("ssh://evil.example/x@github.com/a/b")).toBeNull();
    expect(parseGithubRemote("/local/path/repo.git")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });

  it("does not accept a path deeper than owner/repo", () => {
    expect(parseGithubRemote("https://github.com/a/b/c.git")).toBeNull();
  });
});

describe("parseRepoSlug", () => {
  it("accepts owner/name and a pasted URL", () => {
    expect(parseRepoSlug("acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseRepoSlug("acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseRepoSlug("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("rejects junk", () => {
    expect(parseRepoSlug("widgets")).toBeNull();
    expect(parseRepoSlug("acme/widgets/extra")).toBeNull();
    expect(parseRepoSlug("-acme/widgets")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

describe("helpers", () => {
  it("formats and detects", () => {
    expect(formatRepoSlug({ owner: "a", repo: "b" })).toBe("a/b");
    expect(isGithubRemote("git@github.com:a/b.git")).toBe(true);
    expect(isGithubRemote("https://gitlab.com/a/b.git")).toBe(false);
    expect(isGithubHttpsRemote("https://github.com/a/b.git")).toBe(true);
    expect(isGithubHttpsRemote("git@github.com:a/b.git")).toBe(false);
    expect(isGithubHttpsRemote("ssh://git@github.com/a/b.git")).toBe(false);
  });
});
