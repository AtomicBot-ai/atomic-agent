import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeApprovingGate,
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "../os/git/test-helpers.js";
import {
  autofixLocalBranch,
  autofixPushArgs,
  inspectAutofixWorktree,
  prepareAutofixWorktree,
  pushAutofixWorktree,
} from "./pr-autofix-git.js";

describe("autofixPushArgs", () => {
  it("names the PR head as the only remote ref and never forces", () => {
    expect(autofixPushArgs("feat/x")).toEqual(["push", "origin", "HEAD:refs/heads/feat/x"]);
    expect(autofixPushArgs("feat/x").join(" ")).not.toMatch(/--force|-f\b|\+/);
  });

  it("refuses a target that git would read as an option", () => {
    expect(() => autofixPushArgs("--force")).toThrow(/must not start with '-'/);
  });
});

/** A local bare `origin` stands in for GitHub; the PR branch is feat/x. */
describe("prepare, inspect and push against a local origin", () => {
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
    bare = await mkdtemp(join(tmpdir(), "autofix-bare-"));
    parent = await mkdtemp(join(tmpdir(), "autofix-wt-"));
    await runGitRaw(bare, ["init", "--bare", "-q", "--initial-branch=main"]);
    await runGitRaw(repo, ["remote", "add", "origin", bare]);
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await runGitRaw(repo, ["push", "-q", "origin", "main"]);
    // The user's own checkout stays on the PR branch: the worktree must not need it.
    await runGitRaw(repo, ["checkout", "-q", "-b", "feat/x"]);
    await writeRepoFile(repo, "a.txt", "two\n");
    await runGitRaw(repo, ["commit", "-q", "-am", "feature"]);
    await runGitRaw(repo, ["push", "-q", "origin", "feat/x"]);
  }, 30_000);

  afterEach(async () => {
    for (const dir of [repo, bare, parent]) await rm(dir, { recursive: true, force: true });
  });

  it("makes a worktree on its own branch, refuses an uncommitted fix, pushes a committed one to the PR head only", async () => {
    const ctx = makeCtx(repo);
    const dir = join(parent, "pr-42");
    const mainBefore = (await runGitRaw(bare, ["rev-parse", "main"])).stdout.trim();
    const prHead = (await runGitRaw(bare, ["rev-parse", "feat/x"])).stdout.trim();

    const prepared = await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);
    expect(prepared).toMatchObject({ dir, localBranch: autofixLocalBranch(42), headSha: prHead, created: true });

    await writeRepoFile(dir, "a.txt", "fixed\n");
    await expect(inspectAutofixWorktree({ number: 42, dir }, ctx)).rejects.toThrow(/uncommitted changes/);

    await runGitRaw(dir, ["commit", "-q", "-am", "fix(ci): lint"]);
    const { headSha } = await inspectAutofixWorktree({ number: 42, dir }, ctx);
    expect(headSha).not.toBe(prHead);

    await pushAutofixWorktree(options, { dir, target: "feat/x" }, ctx);
    expect((await runGitRaw(bare, ["rev-parse", "feat/x"])).stdout.trim()).toBe(headSha);
    expect((await runGitRaw(bare, ["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
    const remoteBranches = (await runGitRaw(bare, ["branch", "--list"])).stdout;
    expect(remoteBranches).not.toContain("pr-autofix");

    // A second prepare fast-forwards the same worktree instead of making a new one.
    const again = await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);
    expect(again).toMatchObject({ created: false, headSha });
  }, 60_000);

  it("is rejected, not forced, when the PR head moved underneath", async () => {
    const ctx = makeCtx(repo);
    const dir = join(parent, "pr-42");
    await prepareAutofixWorktree(options, { number: 42, headRef: "feat/x", dir }, ctx);
    // Someone else pushes to the PR branch first.
    await writeRepoFile(repo, "b.txt", "theirs\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-q", "-m", "theirs"]);
    await runGitRaw(repo, ["push", "-q", "origin", "feat/x"]);
    const theirs = (await runGitRaw(bare, ["rev-parse", "feat/x"])).stdout.trim();

    await writeRepoFile(dir, "a.txt", "fixed\n");
    await runGitRaw(dir, ["commit", "-q", "-am", "fix"]);
    await expect(pushAutofixWorktree(options, { dir, target: "feat/x" }, ctx)).rejects.toThrow(/rejected/);
    expect((await runGitRaw(bare, ["rev-parse", "feat/x"])).stdout.trim()).toBe(theirs);
  }, 60_000);
});
