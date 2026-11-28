import { describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../approval/approval-gate.js";
import { approvalRequestPayload, resolveApprovalResponse } from "./approval-payload.js";

/**
 * ATO-2486: a password an interactive shell job asks for reaches a host
 * as an `approval_request` with `secretInput`, and comes back in
 * `approval_response.secret`.
 */

const VALUE = "correct horse 42!";

function ask(): { gate: ApprovalGate; pending: Promise<ApprovalDecision> } {
  const gate = new ApprovalGate({ level: 5, emit: () => {} });
  const pending = gate.request({
    approvalId: "sec-1",
    sessionId: "s",
    tool: "os.shell.run",
    category: "shell_secret_input",
    reason: "job 1 (sudo apt update) asks for sudo password",
    secretInput: { jobId: 1, label: "sudo password", commandLine: "sudo apt update", promptLine: "Password:" },
  });
  return { gate, pending };
}

describe("sidecar shell_secret_input payloads (ATO-2486)", () => {
  it("the request carries what to draw, and offers no grant", () => {
    const request: ApprovalRequest = {
      approvalId: "sec-1",
      sessionId: "s",
      tool: "os.shell.run",
      category: "shell_secret_input",
      reason: "asks for sudo password",
      secretInput: { jobId: 1, label: "sudo password", commandLine: "sudo apt update", promptLine: "" },
    };
    const payload = approvalRequestPayload(request, undefined);
    expect(payload.secretInput).toEqual(request.secretInput);
    expect(payload).toMatchObject({ category: "shell_secret_input", canSession: false, canShape: false, canAlways: false });
  });

  it("an approve carries the typed value to the tool", async () => {
    const { gate, pending } = ask();
    expect(resolveApprovalResponse({ approvalId: "sec-1", approved: true, secret: VALUE }, gate)).toBe(true);
    expect((await pending).secret).toBe(VALUE);
  });

  it("an approve without a usable value fails and the request stays open; the error never names it", () => {
    const { gate } = ask();
    expect(() => resolveApprovalResponse({ approvalId: "sec-1", approved: true }, gate)).toThrow(/still open/);
    expect(() => resolveApprovalResponse({ approvalId: "sec-1", approved: true, secret: "a\nb" }, gate)).toThrow(
      /one line/,
    );
    expect(gate.isPending("sec-1")).toBe(true);
    gate.resolve({ approvalId: "sec-1", approved: false, automatic: true });
  });

  it("a deny skips it without a value", async () => {
    const { gate, pending } = ask();
    resolveApprovalResponse({ approvalId: "sec-1", approved: false }, gate);
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.secret).toBeUndefined();
  });
});
