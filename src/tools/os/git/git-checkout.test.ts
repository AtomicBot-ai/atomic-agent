import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCheckoutTool, requireBranchName } from "./git-checkout.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

function denyAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.reject(req.approvalId, "denied"),
  });
  return gate;
}

describe("os.git.checkout", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("creates and switches to a branch", async () => {
    const tool = buildOsGitCheckoutTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run({ branch: "feat/x", create: true }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.created).toBe(true);
    const head = await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("feat/x");
  });

  it("switches to an existing branch", async () => {
    await runGitRaw(repo, ["branch", "other"]);
    const tool = buildOsGitCheckoutTool({ approvals: approveAll(), approvalRequired: true });
    await tool.run({ branch: "other" }, makeCtx(repo));
    const head = await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("other");
  });

  it("does nothing when approval is denied", async () => {
    const tool = buildOsGitCheckoutTool({ approvals: denyAll(), approvalRequired: true });
    await expect(
      tool.run({ branch: "feat/x", create: true }, makeCtx(repo)),
    ).rejects.toThrow(/approval denied/);
    const head = await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("main");
  });

  it("asks for approval with the git command as the preview", async () => {
    let preview: string | undefined;
    const gate = new ApprovalGate({
      emit: (req) => {
        preview = req.preview;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsGitCheckoutTool({ approvals: gate, approvalRequired: true });
    await tool.run({ branch: "feat/y", create: true, startPoint: "main" }, makeCtx(repo));
    expect(preview).toBe("git checkout -b feat/y main");
  });

  it("refuses a missing branch with git's own reason", async () => {
    const tool = buildOsGitCheckoutTool({ approvals: approveAll(), approvalRequired: false });
    await expect(tool.run({ branch: "nope" }, makeCtx(repo))).rejects.toThrow(
      /os\.git\.checkout: git .*checkout nope exited/,
    );
  });

  it("rejects startPoint without create", async () => {
    const tool = buildOsGitCheckoutTool({ approvals: approveAll(), approvalRequired: false });
    await expect(
      tool.run({ branch: "main", startPoint: "HEAD~1" }, makeCtx(repo)),
    ).rejects.toThrow(/only makes sense with/);
  });
});

describe("requireBranchName", () => {
  it("rejects flag-shaped and blank names", () => {
    expect(() => requireBranchName("--orphan", "t")).toThrow(/must not start with '-'/);
    expect(() => requireBranchName("", "t")).toThrow(/non-empty/);
    expect(() => requireBranchName("a b", "t")).toThrow(/whitespace/);
    expect(requireBranchName(" feat/x ", "t")).toBe("feat/x");
  });
});
