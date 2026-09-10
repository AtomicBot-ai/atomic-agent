import { describe, it, expect } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import { ApprovalDeniedError, requireApproval } from "./dangerous-tool.js";

/**
 * Per-session prompt policy (fusion workers). A session under a refuse
 * policy never reaches an emitter; other sessions prompt as before;
 * auto-approval still wins; clearing restores the prompt.
 */
describe("ApprovalGate session policy", () => {
  const shellRequest = (sessionId: string) => ({
    sessionId,
    tool: "os.shell.run",
    category: "shell" as const,
    reason: "run tests",
  });

  it("refuses without emitting, with the policy's reason", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 1 });
    gate.setSessionPolicy("s-w-1", {
      onPrompt: "refuse",
      reason: "no operator",
    });
    const decision = await gate.request(shellRequest("s-w-1"));
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("no operator");
    expect(emitted).toEqual([]);
    expect(gate.pendingCount()).toBe(0);
  });

  it("is per-session: another session still prompts", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 1 });
    gate.setSessionPolicy("s-w-1", {
      onPrompt: "refuse",
      reason: "no operator",
    });
    const other = gate.request(shellRequest("s-real"));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.sessionId).toBe("s-real");
    expect(
      gate.resolve({ approvalId: emitted[0]!.approvalId, approved: true }),
    ).toBe(true);
    await expect(other).resolves.toMatchObject({ approved: true });
  });

  it("auto-approval above the threshold still wins over the policy", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    gate.setSessionPolicy("s-w-1", {
      onPrompt: "refuse",
      reason: "no operator",
    });
    const decision = await gate.request(shellRequest("s-w-1"));
    expect(decision.approved).toBe(true);
    expect(decision.reason).toMatch(/auto-approved/);
    expect(emitted).toEqual([]);
  });

  it("a session grant still wins over the policy", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 1 });
    // Record a category grant for the session first, then install the policy.
    const first = gate.request(shellRequest("s-w-1"));
    gate.resolve({
      approvalId: emitted[0]!.approvalId,
      approved: true,
      grant: "category",
    });
    await first;
    gate.setSessionPolicy("s-w-1", {
      onPrompt: "refuse",
      reason: "no operator",
    });
    const decision = await gate.request(shellRequest("s-w-1"));
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("auto-approved (session grant)");
  });

  it("clearSessionPolicy restores prompting", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 1 });
    gate.setSessionPolicy("s-w-1", {
      onPrompt: "refuse",
      reason: "no operator",
    });
    gate.clearSessionPolicy("s-w-1");
    const pending = gate.request(shellRequest("s-w-1"));
    expect(emitted).toHaveLength(1);
    gate.denyPendingForSession("s-w-1", "cleanup");
    await expect(pending).resolves.toMatchObject({
      approved: false,
      reason: "cleanup",
    });
  });

  it("surfaces through requireApproval as ApprovalDeniedError carrying the reason", async () => {
    const gate = new ApprovalGate({ emit: () => undefined, level: 1 });
    gate.setSessionPolicy("s-w-1", {
      onPrompt: "refuse",
      reason: "hand it back",
    });
    await expect(
      requireApproval(
        { approvals: gate, approvalRequired: true },
        { ...shellRequest("s-w-1") },
        new AbortController().signal,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApprovalDeniedError &&
        err.reason === "hand it back" &&
        err.message.includes("hand it back"),
    );
  });
});
