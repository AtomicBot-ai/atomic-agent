import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
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

/**
 * The user shell-guard rules (`shellGuard.*` in config.json, issue
 * #229) through the escape hatch. The sandwich property, end to end: a
 * deny pattern pulls a command the guard would have allowed silently
 * into the approval ladder (a declined prompt is `ApprovalDeniedError`),
 * while an allow pattern can never lift a command over the built-in
 * dangerous layer.
 */
describe("os.shell.run honours user shell-guard rules", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-userguard-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a deny pattern turns a silent safe-allow into a prompt, and a declined prompt denies the call", async () => {
    let prompts = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        gate.reject(req.approvalId, "no");
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: {
        isGitRemoteSyncEnabled: () => true,
        userGuardRules: () => ({ deny: ["echo *"], allow: [] }),
      },
    });
    await expect(
      tool.run({ cmd: "echo", args: ["hi"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toBe(1);
  });

  it("an allow pattern runs the command without a prompt", async () => {
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
      shellPolicy: {
        isGitRemoteSyncEnabled: () => true,
        userGuardRules: () => ({ deny: [], allow: ["echo *"] }),
      },
    });
    const result = await tool.run({ cmd: "echo", args: ["hi"] }, makeCtx(dir));
    expect(result.status).not.toBe("error");
    expect(prompts).toBe(0);
  });

  it("an allow pattern does not bypass the dangerous layer", async () => {
    let prompts = 0;
    let promptedReason = "";
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        promptedReason = req.reason;
        gate.reject(req.approvalId, "no");
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: {
        isGitRemoteSyncEnabled: () => true,
        userGuardRules: () => ({ deny: [], allow: ["rm *"] }),
      },
    });
    // `rm -r` is a dangerous verdict on its own; the user allow sits
    // after the dangerous layer, so the prompt is the dangerous one.
    await expect(
      tool.run({ cmd: "rm", args: ["-r", "./build"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toBe(1);
    expect(promptedReason).toContain("recursive remove");
  });
});
