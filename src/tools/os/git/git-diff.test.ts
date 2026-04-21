import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitDiffTool } from "./git-diff.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

describe("os.git.diff", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("shows a working-tree diff", async () => {
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "TWO\n");

    const result = await osGitDiffTool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.empty).toBe(false);
    expect(result.details.added).toBe(1);
    expect(result.details.removed).toBe(1);
    expect(result.summary).toContain("+TWO");
  });

  it("shows the staged diff when staged=true", async () => {
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "staged\n");
    await runGitRaw(repo, ["add", "a.txt"]);

    const staged = await osGitDiffTool.run({ staged: true }, makeCtx(repo));
    expect(staged.details.empty).toBe(false);

    // Working tree is now identical to index → non-staged diff is empty.
    const working = await osGitDiffTool.run({}, makeCtx(repo));
    expect(working.details.empty).toBe(true);
  });

  it("returns (no diff) marker when clean", async () => {
    await writeRepoFile(repo, "a.txt", "x\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    const result = await osGitDiffTool.run({}, makeCtx(repo));
    expect(result.details.empty).toBe(true);
    expect(result.summary).toBe("(no diff)");
  });
});
