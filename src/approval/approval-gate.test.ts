import { describe, it, expect } from "vitest";
import { ApprovalGate } from "./approval-gate.js";

describe("ApprovalGate", () => {
  it("emits a request and resolves with the host decision", async () => {
    let capturedId = "";
    const gate = new ApprovalGate({
      emit: (req) => {
        capturedId = req.approvalId;
        setImmediate(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
      },
    });
    const decision = await gate.request({
      sessionId: "s",
      tool: "apply_patch",
      reason: "test",
    });
    expect(decision.approved).toBe(true);
    expect(decision.approvalId).toBe(capturedId);
  });

  it("auto-approves when configured", async () => {
    const gate = new ApprovalGate({
      emit: () => {
        throw new Error("should not emit when auto-approving");
      },
      autoApprove: true,
    });
    const decision = await gate.request({ sessionId: "s", tool: "run_test", reason: "t" });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("auto-approved");
  });

  it("aborts via signal without a host response", async () => {
    const controller = new AbortController();
    const gate = new ApprovalGate({ emit: () => {} });
    const promise = gate.request(
      { sessionId: "s", tool: "apply_patch", reason: "t" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "ApprovalGateError" });
  });

  it("reject() resolves the pending request as denied", async () => {
    let pendingId = "";
    const gate = new ApprovalGate({
      emit: (req) => {
        pendingId = req.approvalId;
      },
    });
    const promise = gate.request({ sessionId: "s", tool: "run_test", reason: "t" });
    expect(pendingId.length).toBeGreaterThan(0);
    gate.reject(pendingId, "not safe");
    const decision = await promise;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("not safe");
  });
});
