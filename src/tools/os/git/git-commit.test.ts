import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCommitTool } from "./git-commit.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

async function log(repo: string): Promise<string[]> {
  const res = await runGitRaw(repo, ["log", "--format=%s"]);
  return res.stdout.trim().split("\n").filter(Boolean);
}

describe("os.git.commit", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
  }, 30_000);
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  }, 30_000);

  it("stages the given paths and commits", async () => {
    await writeRepoFile(repo, "a.txt", "two\n");
    await writeRepoFile(repo, "b.txt", "new\n");
    const tool = buildOsGitCommitTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run(
      { message: "feat: a only", paths: ["a.txt"] },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(typeof result.details.hash).toBe("string");
    expect(await log(repo)).toEqual(["feat: a only", "init"]);
    // b.txt stayed untracked.
    const status = await runGitRaw(repo, ["status", "--porcelain"]);
    expect(status.stdout).toContain("?? b.txt");
  });

  it("stages everything with all: true", async () => {
    await writeRepoFile(repo, "a.txt", "two\n");
    await writeRepoFile(repo, "b.txt", "new\n");
    const tool = buildOsGitCommitTool({ approvals: approveAll(), approvalRequired: true });
    await tool.run({ message: "feat: everything", all: true }, makeCtx(repo));
    const status = await runGitRaw(repo, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("commits only the index when neither paths nor all is given", async () => {
    await writeRepoFile(repo, "a.txt", "two\n");
    await writeRepoFile(repo, "c.txt", "staged\n");
    await runGitRaw(repo, ["add", "c.txt"]);
    const tool = buildOsGitCommitTool({ approvals: approveAll(), approvalRequired: true });
    await tool.run({ message: "chore: staged only" }, makeCtx(repo));
    const status = await runGitRaw(repo, ["status", "--porcelain"]);
    expect(status.stdout).toContain(" M a.txt");
    expect(status.stdout).not.toContain("c.txt");
  });

  it("puts the files that will be committed in the approval preview", async () => {
    await writeRepoFile(repo, "a.txt", "two\n");
    let preview: string | undefined;
    let reason: string | undefined;
    const gate = new ApprovalGate({
      emit: (req) => {
        preview = req.preview;
        reason = req.reason;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsGitCommitTool({ approvals: gate, approvalRequired: true });
    await tool.run({ message: "fix: a\n\nlonger body" }, makeCtx(repo)).catch(() => {});
    expect(reason).toBe('commit "fix: a"');
    expect(preview).toContain("committing what is already staged");
  });

  it("does not stage when approval is denied", async () => {
    await writeRepoFile(repo, "b.txt", "new\n");
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied"),
    });
    const tool = buildOsGitCommitTool({ approvals: gate, approvalRequired: true });
    await expect(
      tool.run({ message: "x", all: true }, makeCtx(repo)),
    ).rejects.toThrow(/approval denied/);
    const status = await runGitRaw(repo, ["status", "--porcelain"]);
    expect(status.stdout).toContain("?? b.txt");
    expect(await log(repo)).toEqual(["init"]);
  });

  it("says so when there is nothing to commit", async () => {
    const tool = buildOsGitCommitTool({ approvals: approveAll(), approvalRequired: false });
    await expect(tool.run({ message: "empty" }, makeCtx(repo))).rejects.toThrow(
      /nothing to commit/,
    );
  });

  it("validates its arguments", async () => {
    const tool = buildOsGitCommitTool({ approvals: approveAll(), approvalRequired: false });
    await expect(tool.run({}, makeCtx(repo))).rejects.toThrow(/`message`/);
    await expect(
      tool.run({ message: "m", paths: ["a"], all: true }, makeCtx(repo)),
    ).rejects.toThrow(/either `paths` or `all`/);
    await expect(
      tool.run({ message: "m", paths: ["--all"] }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with '-'/);
  });
});
