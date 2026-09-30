import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { GitRunResult } from "./git-runner.js";
import {
  REMOTE_SYNC_OFF_MESSAGE,
  gitFailureResult,
  refuseWhenRemoteSyncOff,
  requireGitRemoteApproval,
} from "./git-remote-policy.js";

describe("refuseWhenRemoteSyncOff", () => {
  it("returns a structured error naming the switch while sync is off", () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    const refused = refuseWhenRemoteSyncOff("os.git.push", {
      approvals: gate,
      approvalRequired: true,
      isRemoteSyncEnabled: () => false,
    });
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe("error");
    expect(refused!.summary).toContain("remote sync is off");
    expect(refused!.summary).toContain("Integrations");
    expect(refused!.details.refused).toBe(true);
    expect(REMOTE_SYNC_OFF_MESSAGE).toMatch(/Nothing was sent or fetched/);
  });

  it("says how to turn the switch back on, whole, however the wording grows", () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    const refused = refuseWhenRemoteSyncOff("os.git.push", {
      approvals: gate,
      approvalRequired: true,
      isRemoteSyncEnabled: () => false,
    });
    // The clause that tells the operator where the switch lives is the
    // last one, so it is the first to go if this is ever compressed on
    // the 400-character default.
    expect(refused!.summary).toBe(`os.git.push: ${REMOTE_SYNC_OFF_MESSAGE}`);
    expect(refused!.summary).toContain(
      "do not look for another way to reach the remote.",
    );
    expect(refused!.truncated).toBe(false);
  });

  it("is a no-op once sync is on", () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    expect(
      refuseWhenRemoteSyncOff("os.git.push", {
        approvals: gate,
        approvalRequired: true,
        isRemoteSyncEnabled: () => true,
      }),
    ).toBeNull();
  });
});

describe("requireGitRemoteApproval", () => {
  it("always files the request under git_remote with the call's preview", async () => {
    const seen: Array<{ category: string; preview?: string; tool: string }> = [];
    const gate = new ApprovalGate({
      emit: (req) => {
        seen.push({ category: req.category, preview: req.preview, tool: req.tool });
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    await requireGitRemoteApproval(
      { approvals: gate, approvalRequired: true },
      {
        sessionId: "s",
        tool: "os.git.push",
        reason: "push main to origin",
        preview: "git push origin main",
        affectedResources: ["/repo"],
      },
      new AbortController().signal,
    );
    expect(seen).toEqual([
      { category: "git_remote", preview: "git push origin main", tool: "os.git.push" },
    ]);
  });

  it("surfaces a denial as ApprovalDeniedError", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "no"),
    });
    await expect(
      requireGitRemoteApproval(
        { approvals: gate, approvalRequired: true },
        {
          sessionId: "s",
          tool: "os.git.fetch",
          reason: "r",
          preview: "git fetch origin",
          affectedResources: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });
});

/**
 * `git push` prints the whole reason a push was rejected after the
 * rejection itself: five `hint:` lines, the last of which is the one
 * that tells the model to pull first. Copied out of a real rejected
 * push against a bare repository.
 */
const REJECTED_PUSH = `To github.com:AtomicBot-ai/atomic-agent.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'github.com:AtomicBot-ai/atomic-agent.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.`;

function rejectedPush(): GitRunResult {
  return {
    command: "git",
    args: ["push", "origin", "main"],
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: REJECTED_PUSH,
    durationMs: 640,
    timedOut: false,
    truncated: false,
    repoRoot: "/repo",
  };
}

describe("gitFailureResult", () => {
  it("keeps the hints that say how to unblock a rejected push", () => {
    const result = gitFailureResult("os.git.push", rejectedPush(), { remote: "origin" });
    expect(result.status).toBe("error");
    expect(result.summary.split("\n")[0]).toBe(
      "key: error: failed to push some refs to 'github.com:AtomicBot-ai/atomic-agent.git'",
    );
    expect(result.summary).toContain("os.git.push: git exited with 1");
    expect(result.summary).toContain(
      "hint: the same ref. If you want to integrate the remote changes, use",
    );
    expect(result.summary.endsWith(
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    )).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.details).toMatchObject({ remote: "origin", exitCode: 1, timedOut: false });
  });

  it("is a real improvement on the compressor's defaults", () => {
    const onDefaults = compressToolResult({
      tool: "os.git.push",
      status: "error",
      output: `os.git.push: git exited with 1\n${REJECTED_PUSH}`,
    });
    expect(onDefaults.summary).not.toContain("'git pull' before pushing again.");
    expect(onDefaults.truncated).toBe(true);
  });
});
