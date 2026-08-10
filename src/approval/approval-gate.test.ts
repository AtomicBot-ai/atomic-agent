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
      category: "other",
      reason: "test",
    });
    expect(decision.approved).toBe(true);
    expect(decision.approvalId).toBe(capturedId);
  });

  it("setLevel moves the gate live in both directions", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: false }),
        );
      },
    });
    expect(gate.getLevel()).toBe(1);

    gate.setLevel(5);
    expect(gate.getLevel()).toBe(5);
    const auto = await gate.request({
      sessionId: "s",
      tool: "t",
      category: "shell",
      reason: "r",
    });
    expect(auto.approved).toBe(true);
    expect(auto.reason).toBe("auto-approved (level 5)");
    expect(emitted).toBe(0);

    gate.setLevel(1);
    expect(gate.getLevel()).toBe(1);
    const interactive = await gate.request({
      sessionId: "s",
      tool: "t",
      category: "shell",
      reason: "r",
    });
    expect(interactive.approved).toBe(false);
    expect(emitted).toBe(1);
  });

  it("auto-approves by category from the configured level", async () => {
    const gate = new ApprovalGate({
      emit: () => {
        throw new Error("should not emit when auto-approving");
      },
      level: 5,
    });
    const decision = await gate.request({
      sessionId: "s",
      tool: "run_test",
      category: "other",
      reason: "t",
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("auto-approved (level 5)");
  });

  it("at a mid-ladder level, silences covered categories and prompts the rest", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: false }),
        );
      },
      level: 2,
    });
    const silent = await gate.request({
      sessionId: "s",
      tool: "os.fs.write",
      category: "fs_write_workspace",
      reason: "write",
    });
    expect(silent.approved).toBe(true);
    expect(emitted).toBe(0);

    const asked = await gate.request({
      sessionId: "s",
      tool: "os.fs.write",
      category: "fs_write_home",
      reason: "write",
    });
    expect(asked.approved).toBe(false);
    expect(emitted).toBe(1);
  });

  it("clamps out-of-range setLevel input", () => {
    const gate = new ApprovalGate({ emit: () => {} });
    gate.setLevel(99);
    expect(gate.getLevel()).toBe(5);
    gate.setLevel(-3);
    expect(gate.getLevel()).toBe(1);
    gate.setLevel(Number.NaN);
    expect(gate.getLevel()).toBe(1);
  });

  it("aborts via signal without a host response", async () => {
    const controller = new AbortController();
    const gate = new ApprovalGate({ emit: () => {} });
    const promise = gate.request(
      { sessionId: "s", tool: "apply_patch", category: "other", reason: "t" },
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
    const promise = gate.request({
      sessionId: "s",
      tool: "run_test",
      category: "other",
      reason: "t",
    });
    expect(pendingId.length).toBeGreaterThan(0);
    gate.reject(pendingId, "not safe");
    const decision = await promise;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("not safe");
  });
});
