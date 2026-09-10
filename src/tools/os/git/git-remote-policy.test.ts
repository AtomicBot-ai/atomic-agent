import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import {
  REMOTE_SYNC_OFF_MESSAGE,
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
