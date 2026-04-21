import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitShowTool } from "./git-show.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

describe("os.git.show", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns commit metadata + numstat + patch for HEAD", async () => {
    await writeRepoFile(repo, "a.txt", "one\n");
    await writeRepoFile(repo, "b.txt", "two\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "seed the repo", "-m", "extended body"]);

    const result = await osGitShowTool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.commit.subject).toBe("seed the repo");
    expect(result.details.commit.body).toBe("extended body");
    expect(result.details.fileCount).toBe(2);
    const paths = (
      result.details.files as { path: string; addedLines: number }[]
    ).map((f) => f.path);
    expect(paths.sort()).toEqual(["a.txt", "b.txt"]);
    expect(result.summary).toContain("commit ");
    expect(result.summary).toContain("+++ b/a.txt");
  });

  it("suppresses patch when patch=false", async () => {
    await writeRepoFile(repo, "a.txt", "x\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    const result = await osGitShowTool.run({ patch: false }, makeCtx(repo));
    expect(result.details.includePatch).toBe(false);
    expect(result.summary).not.toContain("+++");
  });

  it("resolves an explicit revision", async () => {
    await writeRepoFile(repo, "a.txt", "first\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "first"]);
    const first = (
      await runGitRaw(repo, ["rev-parse", "HEAD"])
    ).stdout.trim();
    await writeRepoFile(repo, "b.txt", "second\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "second"]);

    const result = await osGitShowTool.run({ revision: first }, makeCtx(repo));
    expect(result.details.commit.subject).toBe("first");
  });
});
