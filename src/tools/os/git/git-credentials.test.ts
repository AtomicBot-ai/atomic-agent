import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { runCommand } from "../../../sandbox/command-runner.js";
import {
  GIT_CREDENTIAL_ENV,
  buildCredentialInjection,
  hasEmbeddedUserinfo,
  readGithubToken,
  redactSecret,
  sshBatchEnv,
} from "./git-credentials.js";
import { makeGitRepo } from "./test-helpers.js";

const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";

describe("buildCredentialInjection", () => {
  it("is empty without a token so git keeps the operator's own helpers", () => {
    expect(buildCredentialInjection(undefined)).toEqual({ args: [], env: {} });
    expect(buildCredentialInjection("   ")).toEqual({ args: [], env: {} });
  });

  it("never puts the token in argv — only in the child's environment", () => {
    const { args, env } = buildCredentialInjection(TOKEN);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(env[GIT_CREDENTIAL_ENV]).toBe(TOKEN);
    expect(process.env[GIT_CREDENTIAL_ENV]).toBeUndefined();
  });

  it("binds the helper to https://github.com only", () => {
    const { args } = buildCredentialInjection(TOKEN);
    expect(args.filter((a) => a.startsWith("credential."))).toEqual(
      expect.arrayContaining([
        "credential.https://github.com.helper=",
        expect.stringMatching(/^credential\.https:\/\/github\.com\.helper=!f\(\)/),
      ]),
    );
    expect(args.some((a) => /^credential\.helper=/.test(a))).toBe(false);
  });
});

describe("the inline helper, run by real git", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo("atomic-git-cred-");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function fill(host: string, injection = buildCredentialInjection(TOKEN)) {
    // `git credential fill` is exactly the lookup a fetch/push performs.
    return runCommand("git", [...injection.args, "credential", "fill"], {
      cwd: repo,
      timeoutMs: 10_000,
      input: `protocol=https\nhost=${host}\n\n`,
      env: {
        ...process.env,
        ...injection.env,
        GIT_TERMINAL_PROMPT: "0",
        // No keychain, no stored helper from the developer's machine.
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  }

  it("hands github.com the token from the child env as x-access-token", async () => {
    const res = await fill("github.com");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("username=x-access-token");
    expect(res.stdout).toContain(`password=${TOKEN}`);
  });

  it("does not answer for any other host", async () => {
    const res = await fill("example.com");
    // With prompting off and no helper for this host, git cannot fill
    // a password: the token must not leak to a non-GitHub remote.
    expect(res.stdout).not.toContain(TOKEN);
    expect(res.stdout).not.toContain("password=");
  });
});

describe("hasEmbeddedUserinfo", () => {
  it.each([
    "https://user:token@github.com/x/y.git",
    "https://token@github.com/x/y.git",
    "http://a:b@example.com/repo",
    "ssh://git@github.com/x/y.git",
  ])("flags %s", (url) => {
    expect(hasEmbeddedUserinfo(url)).toBe(true);
  });

  it.each([
    "https://github.com/x/y.git",
    "git@github.com:x/y.git",
    "/local/path/repo.git",
    "file:///tmp/repo.git",
    "https://github.com/x/y?ref=a@b",
  ])("passes %s", (url) => {
    expect(hasEmbeddedUserinfo(url)).toBe(false);
  });
});

describe("redactSecret / readGithubToken / sshBatchEnv", () => {
  it("replaces every occurrence and leaves text alone without a secret", () => {
    expect(redactSecret(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a *** b ***");
    expect(redactSecret("plain", undefined)).toBe("plain");
    expect(redactSecret("plain", "")).toBe("plain");
  });

  it("reads and trims GITHUB_TOKEN from the given env only", () => {
    expect(readGithubToken({ GITHUB_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    expect(readGithubToken({})).toBeUndefined();
    expect(readGithubToken({ GITHUB_TOKEN: "" })).toBeUndefined();
  });

  it("puts ssh in batch mode unless the operator set GIT_SSH_COMMAND", () => {
    expect(sshBatchEnv({})).toEqual({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    expect(sshBatchEnv({ GIT_SSH_COMMAND: "ssh -i key" })).toEqual({});
  });
});
