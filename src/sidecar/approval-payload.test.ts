import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../approval/approval-gate.js";
import { ApprovalRulesStore } from "../approval/approval-rules-store.js";
import { approvalRequestPayload, responseGrant } from "./approval-payload.js";

/**
 * ATO-1270: the sidecar's `approval_request` carries what a host needs
 * to offer "in this chat" and "always", and `approval_response` can send
 * that answer back.
 */
describe("sidecar approval payloads (ATO-1270)", () => {
  let stateDir: string;
  let project: string;
  let pending: ApprovalRequest[];
  let gate: ApprovalGate;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "sidecar-approval-state-"));
    project = mkdtempSync(join(tmpdir(), "sidecar-approval-project-"));
    pending = [];
    gate = new ApprovalGate({ level: 1, emit: (r) => pending.push(r) });
    gate.setRules(new ApprovalRulesStore({ stateDir }));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function gitStatus(): Omit<ApprovalRequest, "approvalId"> {
    return {
      sessionId: "s",
      tool: "os.shell.run",
      category: "shell",
      reason: "git status in /x",
      preview: "git status",
      affectedResources: [project],
      commandShape: "git",
      commandArgv: ["git", "status"],
      workdir: project,
    };
  }

  it("a shell request carries its shape and every grant it can take", () => {
    const request: ApprovalRequest = { approvalId: "a1", ...gitStatus() };
    const payload = approvalRequestPayload(request, gate);
    expect(payload).toMatchObject({
      approvalId: "a1",
      sessionId: "s",
      tool: "os.shell.run",
      category: "shell",
      preview: "git status",
      commandShape: "git",
      canSession: true,
      canShape: true,
      canAlways: true,
    });
    expect(payload.alwaysLabel).toContain("git status");
  });

  it("a dangerous shell request offers no remembered answer", () => {
    const request: ApprovalRequest = {
      approvalId: "a2",
      sessionId: "s",
      tool: "os.shell.run",
      category: "shell_dangerous",
      reason: "recursive remove",
      workdir: project,
    };
    const payload = approvalRequestPayload(request, gate);
    expect(payload).toMatchObject({ canSession: false, canShape: false, canAlways: false });
    expect(payload.commandShape).toBeUndefined();
    expect(payload.alwaysLabel).toBeUndefined();
  });

  it("carries the risk review's note and level", () => {
    const request: ApprovalRequest = {
      approvalId: "a3",
      ...gitStatus(),
      riskNote: "risk review: medium (pushes)",
      riskLevel: "medium",
    };
    expect(approvalRequestPayload(request, gate)).toMatchObject({
      riskNote: "risk review: medium (pushes)",
      riskLevel: "medium",
    });
  });

  it("without a gate, Always is not offered", () => {
    const request: ApprovalRequest = { approvalId: "a4", ...gitStatus() };
    expect(approvalRequestPayload(request, undefined).canAlways).toBe(false);
  });

  it("a session grant from the host is recorded for the chat", async () => {
    const decision = gate.request(gitStatus());
    const request = pending[0]!;
    const grant = responseGrant({ approvalId: request.approvalId, approved: true, grant: "session" }, gate);
    expect(grant).toBe("category");
    gate.resolve({ approvalId: request.approvalId, approved: true, grant: grant! });
    await expect(decision).resolves.toMatchObject({ approved: true });
    expect(gate.sessionGrants("s").categories).toEqual(["shell"]);
  });

  it("a shape grant from the host is recorded for the binary", async () => {
    const decision = gate.request(gitStatus());
    const request = pending[0]!;
    const grant = responseGrant({ approvalId: request.approvalId, approved: true, grant: "shape" }, gate);
    gate.resolve({ approvalId: request.approvalId, approved: true, grant: grant! });
    await decision;
    expect(gate.sessionGrants("s").shapes).toEqual(["git"]);
  });

  it("a grant the request cannot take fails and leaves it pending", () => {
    void gate.request({
      sessionId: "s",
      tool: "os.shell.run",
      category: "shell_dangerous",
      reason: "recursive remove",
      workdir: project,
    });
    const request = pending[0]!;
    for (const grant of ["session", "shape", "always"] as const) {
      expect(() => responseGrant({ approvalId: request.approvalId, approved: true, grant }, gate)).toThrow(
        /still pending/,
      );
    }
    expect(gate.isPending(request.approvalId)).toBe(true);
  });

  it("a deny or an unknown approval carries no grant", () => {
    expect(responseGrant({ approvalId: "nope", approved: true, grant: "session" }, gate)).toBeUndefined();
    void gate.request(gitStatus());
    const request = pending[0]!;
    expect(responseGrant({ approvalId: request.approvalId, approved: false, grant: "always" }, gate)).toBeUndefined();
  });
});
