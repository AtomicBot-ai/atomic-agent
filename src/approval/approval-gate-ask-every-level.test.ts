import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";

/**
 * ATO-2126: a request marked `askEveryLevel` (a credential read or an
 * encoded command the shell guard is sure of) prompts at level 5, the
 * bypass mode, where every other category runs unasked.
 */
describe("ApprovalGate askEveryLevel", () => {
  const request = {
    sessionId: "s",
    tool: "os.shell.run",
    category: "shell_dangerous" as const,
    reason: "reads a credential file (~/.ssh/id_rsa) in /tmp",
    preview: "cat ~/.ssh/id_rsa",
  };

  it("prompts at full trust when the request asks at every level", async () => {
    const asked: ApprovalRequest[] = [];
    const gate = new ApprovalGate({
      level: 5,
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: false, reason: "no" });
      },
    });
    const decision = await gate.request({ ...request, askEveryLevel: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.askEveryLevel).toBe(true);
    expect(decision.approved).toBe(false);
  });

  it("the same request without the mark runs unasked at full trust", async () => {
    const gate = new ApprovalGate({
      level: 5,
      emit: () => {
        throw new Error("should not prompt at level 5");
      },
    });
    const decision = await gate.request(request);
    expect(decision).toMatchObject({ approved: true, reason: "auto-approved (level 5)" });
  });

  it("a refuse policy still refuses it without a prompt", async () => {
    const gate = new ApprovalGate({
      level: 5,
      emit: () => {
        throw new Error("a refuse policy never prompts");
      },
    });
    gate.setSessionPolicy("s", { onPrompt: "refuse", reason: "worker" });
    const decision = await gate.request({ ...request, askEveryLevel: true });
    expect(decision).toMatchObject({ approved: false, automatic: true });
  });
});
