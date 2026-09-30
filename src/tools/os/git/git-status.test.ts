import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitStatusTool } from "./git-status.js";
import {
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

describe("os.git.status", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports a clean repo after initial commit", async () => {
    await writeRepoFile(repo, "a.txt", "sacred code\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);

    const result = await osGitStatusTool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.clean).toBe(true);
    expect(result.details.branch).toBe("main");
    expect(result.details.entries).toHaveLength(0);
    expect(result.summary).toContain("working tree clean");
  });

  it("reports untracked, modified and staged files", async () => {
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);

    await writeRepoFile(repo, "a.txt", "two\n");
    await writeRepoFile(repo, "b.txt", "new\n");
    await writeRepoFile(repo, "c.txt", "staged\n");
    await runGitRaw(repo, ["add", "c.txt"]);

    const result = await osGitStatusTool.run({}, makeCtx(repo));
    expect(result.details.clean).toBe(false);
    const paths = (
      result.details.entries as {
        path: string;
        indexStatus: string;
        workingStatus: string;
      }[]
    ).map((e) => `${e.indexStatus}${e.workingStatus}:${e.path}`);
    expect(paths).toContain(" M:a.txt");
    expect(paths).toContain("??:b.txt");
    expect(paths).toContain("A :c.txt");
  });

  it("captures rename entries with origin path", async () => {
    await writeRepoFile(repo, "old.txt", "hello\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    await runGitRaw(repo, ["mv", "old.txt", "new.txt"]);

    const result = await osGitStatusTool.run({}, makeCtx(repo));
    const renamed = (
      result.details.entries as {
        path: string;
        indexStatus: string;
        renamedFrom?: string;
      }[]
    ).find((e) => e.indexStatus === "R");
    expect(renamed?.path).toBe("new.txt");
    expect(renamed?.renamedFrom).toBe("old.txt");
  });

  it("accepts an explicit repo argument", async () => {
    await writeRepoFile(repo, "x.txt", "x\n");
    const result = await osGitStatusTool.run({ repo }, makeCtx("/tmp"));
    expect(result.details.clean).toBe(false);
  });

  // A clean tree has ZERO rows, so a row-derived budget is one row
  // wide (280 chars) while the header alone is twice the branch name.
  // Without the floor in `listingResultCaps` the `(working tree
  // clean)` line is cut off and the model cannot tell the tree is
  // clean — a regression on a path that never had the listing bug.
  it("keeps the clean-tree line on a very long branch name", async () => {
    await writeRepoFile(repo, "a.txt", "x\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    const branch = `feature/${"long-branch-name-segment/".repeat(5)}tail`;
    expect(branch.length).toBeGreaterThan(124);
    await runGitRaw(repo, ["checkout", "-q", "-b", branch]);

    const result = await osGitStatusTool.run({}, makeCtx(repo));
    expect(result.details.clean).toBe(true);
    expect(result.summary).toContain(`# branch: ${branch}`);
    expect(result.summary.endsWith("(working tree clean)")).toBe(true);
    expect(result.summary).not.toContain("[truncated]");
  });
});
