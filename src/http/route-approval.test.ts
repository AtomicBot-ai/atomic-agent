import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/approval/resolve", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ approvalRequired: true });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("unblocks a pending approval request", async () => {
    let capturedId: string | null = null;
    harness.approvalBus.subscribe((request: ApprovalRequest) => {
      capturedId = request.approvalId;
    });

    const pending = harness.runtime.approvals.request({
      sessionId: "s-test",
      tool: "os.shell.run",
      reason: "test",
      approvalId: "approval-1",
    });
    expect(capturedId).toBe("approval-1");

    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "approval-1", decision: "allow-once" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resolved: boolean; approved: boolean };
    expect(body.resolved).toBe(true);
    expect(body.approved).toBe(true);

    const decision = await pending;
    expect(decision.approved).toBe(true);
  });

  it("returns 404 when the approvalId is not pending", async () => {
    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "ghost", decision: "deny" }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects unknown decision strings", async () => {
    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "x", decision: "maybe" }),
    });
    expect(response.status).toBe(400);
  });
});
