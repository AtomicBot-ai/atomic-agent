import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

/**
 * The closed-repository switch through the escape hatch: `os.shell.run`
 * must refuse a network git verb before the approval gate is ever
 * consulted, and must stop refusing the moment the switch flips.
 */
describe("os.shell.run honours the git remote-sync policy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-policy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses git push without asking for approval while remote sync is off", async () => {
    let prompts = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => false },
    });
    const result = await tool.run(
      { cmd: "git", args: ["push", "origin", "main"] },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("remote sync is off");
    expect(result.details.guardVerdict).toBe("block");
    expect(result.details.guardRule).toBe("policy.git_remote_sync_off");
    expect(prompts).toBe(0);
  });

  it("refuses a pre-joined command line too (subshell path)", async () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => false },
    });
    const result = await tool.run(
      { cmd: "git fetch --all && git pull", args: [] },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.details.guardRule).toBe("policy.git_remote_sync_off");
  });

  it("asks for approval as usual once remote sync is on", async () => {
    let prompts = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        gate.reject(req.approvalId, "not now");
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => true },
    });
    await expect(
      tool.run({ cmd: "git", args: ["push"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toBe(1);
  });
});
