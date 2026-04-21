import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitBranchTool } from "./git-branch.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

describe("os.git.branch", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("lists local branches and marks the current one", async () => {
    await writeRepoFile(repo, "a.txt", "a");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    await runGitRaw(repo, ["branch", "feature/one"]);
    await runGitRaw(repo, ["branch", "feature/two"]);

    const result = await osGitBranchTool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.currentBranch).toBe("main");
    const branches = result.details.branches as {
      name: string;
      isCurrent: boolean;
      isRemote: boolean;
    }[];
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(["feature/one", "feature/two", "main"]);
    expect(branches.find((b) => b.name === "main")!.isCurrent).toBe(true);
    expect(branches.every((b) => b.isRemote === false)).toBe(true);
  });

  it("filters by pattern", async () => {
    await writeRepoFile(repo, "a.txt", "a");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    await runGitRaw(repo, ["branch", "feature/x"]);
    await runGitRaw(repo, ["branch", "bugfix/y"]);

    const result = await osGitBranchTool.run(
      { pattern: "feature/*" },
      makeCtx(repo),
    );
    const names = (
      result.details.branches as { name: string }[]
    ).map((b) => b.name);
    expect(names).toEqual(["feature/x"]);
  });
});
