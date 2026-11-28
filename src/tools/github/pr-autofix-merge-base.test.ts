import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApprovingGate, makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";
import {
  inspectAutofixWorktree,
  mergeBaseIntoWorktree,
  prepareAutofixWorktree,
  pushAutofixWorktree,
} from "./pr-autofix-git.js";

/**
 * ATO-2516: a PR whose base moved on. A local bare `origin` stands in
 * for GitHub; main is the base and feat/x the PR branch.
 */
describe("merge-base against a local origin", () => {
  let repo: string;
  let bare: string;
  let parent: string;
  const options = {
    approvals: makeApprovingGate(),
    approvalRequired: false,
    isRemoteSyncEnabled: () => true,
    env: {} as NodeJS.ProcessEnv,
  };

  beforeEach(async () => {
    repo = await makeGitRepo();
    bare = await mkdtemp(join(tmpdir(), "autofix-mb-bare-"));
    parent = await mkdtemp(join(tmpdir(), "autofix-mb-wt-"));
    await runGitRaw(bare, ["init", "--bare", "-q", "--initial-branch=main"]);
    await runGitRaw(repo, ["remote", "add", "origin", bare]);
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await runGitRaw(repo, ["push", "-q", "origin", "main"]);
    await runGitRaw(repo, ["checkout", "-q", "-b", "feat/x"]);
    await writeRepoFile(repo, "a.txt", "two\n");
    await runGitRaw(repo, ["commit", "-q", "-am", "feature"]);
    await runGitRaw(repo, ["push", "-q", "origin", "feat/x"]);
    await runGitRaw(repo, ["checkout", "-q", "main"]);
  }, 30_000);

  afterEach(async () => {
    for (const dir of [repo, bare, parent]) await rm(dir, { recursive: true, force: true });
  });

  async function moveMain(file: string, text: string): Promise<string> {
    await writeRepoFile(repo, file, text);
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-q", "-m", `main: ${file}`]);
    await runGitRaw(repo, ["push", "-q", "origin", "main"]);
    return (await runGitRaw(bare, ["rev-parse", "main"])).stdout.trim();
  }

  it("a clean merge is committed and pushed as a fast-forward of the PR head; main is untouched", async () => {
    const mainSha = await moveMain("c.txt", "base change\n");
    const ctx = makeCtx(repo);
    const dir = join(parent, "pr-42");
    const prepared = await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);

    const merged = await mergeBaseIntoWorktree(options, { dir, baseRef: "main", headRef: "feat/x" }, ctx);
    expect(merged.status).toBe("merged");
    const parents = (await runGitRaw(dir, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(" ");
    expect(parents.slice(1)).toEqual([prepared.headSha, mainSha]);

    await pushAutofixWorktree(options, { dir, target: "feat/x" }, ctx);
    expect((await runGitRaw(bare, ["rev-parse", "feat/x"])).stdout.trim()).toBe(merged.headSha);
    expect((await runGitRaw(bare, ["rev-parse", "main"])).stdout.trim()).toBe(mainSha);

    const again = await mergeBaseIntoWorktree(options, { dir, baseRef: "main", headRef: "feat/x" }, ctx);
    expect(again.status).toBe("up-to-date");
  }, 60_000);

  it("a conflict is left for the fix: files named, push refused until it is committed", async () => {
    await moveMain("a.txt", "three\n");
    const ctx = makeCtx(repo);
    const dir = join(parent, "pr-42");
    await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);

    const merged = await mergeBaseIntoWorktree(options, { dir, baseRef: "main", headRef: "feat/x" }, ctx);
    expect(merged).toMatchObject({ status: "conflict", conflicted: ["a.txt"] });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toContain("<<<<<<<");
    await expect(inspectAutofixWorktree({ number: 42, dir }, ctx)).rejects.toThrow(/uncommitted changes/);
    await expect(mergeBaseIntoWorktree(options, { dir, baseRef: "main", headRef: "feat/x" }, ctx)).rejects.toThrow(
      /merge is already in progress/,
    );

    // What os.git.commit with all: true does after the model resolves the file.
    await writeRepoFile(dir, "a.txt", "two and three\n");
    await runGitRaw(dir, ["add", "-A"]);
    await runGitRaw(dir, ["commit", "-q", "-m", "Merge main, keep both"]);
    const { headSha } = await inspectAutofixWorktree({ number: 42, dir }, ctx);
    await pushAutofixWorktree(options, { dir, target: "feat/x" }, ctx);
    expect((await runGitRaw(bare, ["rev-parse", "feat/x"])).stdout.trim()).toBe(headSha);
  }, 60_000);

  it("prepare drops an unfinished merge so the model can start over", async () => {
    await moveMain("a.txt", "three\n");
    const ctx = makeCtx(repo);
    const dir = join(parent, "pr-42");
    const first = await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);
    await mergeBaseIntoWorktree(options, { dir, baseRef: "main", headRef: "feat/x" }, ctx);
    const again = await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);
    expect(again).toMatchObject({ created: false, headSha: first.headSha });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("two\n");
  }, 60_000);
});
