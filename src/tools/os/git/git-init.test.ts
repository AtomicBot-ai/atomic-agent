import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOsGitInitTool } from "./git-init.js";
import {
  makeApprovingGate,
  makeCtx,
  makeGitRepo,
  runGitRaw,
} from "./test-helpers.js";

const GLOBAL_CONFIG_CONTENT = "[core]\n\tautocrlf = false\n";

function tool() {
  return buildOsGitInitTool({
    approvals: makeApprovingGate(),
    approvalRequired: false,
    trustConfigPaths: [],
  });
}

async function currentBranch(repo: string): Promise<string> {
  return (await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
}

async function localConfig(repo: string, key: string): Promise<string> {
  return (await runGitRaw(repo, ["config", "--local", key])).stdout.trim();
}

describe("os.git.init", () => {
  let dir: string;
  let globalConfig: string;
  let savedGlobal: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-git-init-"));
    // Point git's global config at a file we own so "never touches global
    // config" is asserted against a known file, not the host's dotfiles.
    globalConfig = join(dir, "gitconfig-global");
    await writeFile(globalConfig, GLOBAL_CONFIG_CONTENT, "utf8");
    savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });

  afterEach(async () => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a repository with the requested initial branch and a repo-local identity", async () => {
    const target = join(dir, "proj");
    const result = await tool().run(
      {
        path: "proj",
        initialBranch: "trunk",
        userName: "Magos",
        userEmail: "magos@omnissiah.test",
      },
      makeCtx(dir),
    );

    expect(result.status).toBe("ok");
    expect(result.details.alreadyInitialised).toBe(false);
    expect(result.details.repoRoot).toBe(target);
    expect(result.details.initialBranch).toBe("trunk");
    expect((await stat(join(target, ".git"))).isDirectory()).toBe(true);
    expect(await currentBranch(target)).toBe("trunk");
    expect(await localConfig(target, "user.name")).toBe("Magos");
    expect(await localConfig(target, "user.email")).toBe("magos@omnissiah.test");
    expect(result.summary).toContain("trunk");
    expect(result.summary).toContain("Magos <magos@omnissiah.test>");
    // Identity went into the repo, never into the global config.
    expect(await readFile(globalConfig, "utf8")).toBe(GLOBAL_CONFIG_CONTENT);
  });

  it("defaults to the working dir and branch main", async () => {
    const result = await tool().run({}, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.repoRoot).toBe(dir);
    expect(await currentBranch(dir)).toBe("main");
    const toplevel = (await runGitRaw(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect(toplevel).toBe(await realpath(dir));
    expect(result.details.userName).toBeNull();
  });

  it("creates missing parent directories for an explicit path", async () => {
    const target = join(dir, "deep", "er", "proj");
    const result = await tool().run({ path: target }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(await currentBranch(target)).toBe("main");
  });

  it("is a no-op on an existing repository and reports alreadyInitialised", async () => {
    const repo = await makeGitRepo();
    try {
      expect(await currentBranch(repo)).toBe("main");
      const result = await tool().run(
        { path: repo, initialBranch: "other" },
        makeCtx(dir),
      );
      expect(result.status).toBe("ok");
      expect(result.details.alreadyInitialised).toBe(true);
      expect(result.details.initialBranch).toBeNull();
      expect(result.summary).toContain("already a git repository");
      // Not re-initialised: the requested branch name was not applied.
      expect(await currentBranch(repo)).toBe("main");
      expect(await localConfig(repo, "user.name")).toBe("Magos Test");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("still sets a repo-local identity on an existing repository when asked", async () => {
    // The commit tool's identity hint sends the model here; a pure no-op
    // would leave it stuck in a loop.
    const repo = await makeGitRepo();
    try {
      const result = await tool().run(
        { path: repo, userName: "Fabricator", userEmail: "fab@forge.test" },
        makeCtx(dir),
      );
      expect(result.status).toBe("ok");
      expect(result.details.alreadyInitialised).toBe(true);
      expect(await localConfig(repo, "user.name")).toBe("Fabricator");
      expect(await localConfig(repo, "user.email")).toBe("fab@forge.test");
      expect(await readFile(globalConfig, "utf8")).toBe(GLOBAL_CONFIG_CONTENT);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns git's error for an invalid initial branch name", async () => {
    const result = await tool().run(
      { path: "proj", initialBranch: "bad name" },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/invalid initial branch name/);
    await expect(stat(join(dir, "proj", ".git"))).rejects.toThrow();
  });

  it("rejects empty strings and option-like branch names before running git", async () => {
    const blank = await tool().run({ userName: "   " }, makeCtx(dir));
    expect(blank.status).toBe("error");
    expect(blank.summary).toContain("userName");
    const option = await tool().run({ initialBranch: "--bare" }, makeCtx(dir));
    expect(option.status).toBe("error");
    await expect(stat(join(dir, ".git"))).rejects.toThrow();
  });
});
