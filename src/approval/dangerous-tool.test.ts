import { describe, it, expect } from "vitest";
import { ApprovalGate, type ApprovalDecision } from "./approval-gate.js";
import {
  ApprovalDeniedError,
  describeApprovalDenial,
  requireApproval,
} from "./dangerous-tool.js";

/**
 * What the model reads when a gated call is denied (ATO-245). A bare
 * "approval denied for os.fs.write" was read as a policy block — the
 * model told a user who had pressed Deny that "the security system"
 * rejected the file name — so the text says who decided.
 */
describe("a denied approval, as the model reads it", () => {
  const writeRequest = {
    sessionId: "s-1",
    tool: "os.fs.write",
    category: "fs_write_workspace" as const,
    reason: "write notes.txt",
  };

  /** A gate whose one prompt is answered with `decision`. */
  function answering(
    decision: Omit<ApprovalDecision, "approvalId">,
  ): ApprovalGate {
    const gate: ApprovalGate = new ApprovalGate({
      level: 1,
      emit: (req) =>
        queueMicrotask(() =>
          gate.resolve({ approvalId: req.approvalId, ...decision }),
        ),
    });
    return gate;
  }

  async function denialOf(gate: ApprovalGate): Promise<ApprovalDeniedError> {
    try {
      await requireApproval(
        { approvals: gate, approvalRequired: true },
        writeRequest,
        new AbortController().signal,
      );
    } catch (err) {
      if (err instanceof ApprovalDeniedError) return err;
      throw err;
    }
    throw new Error("expected a denial");
  }

  it("a Deny says the user declined, that it is no error or policy block, and not to retry", async () => {
    const err = await denialOf(answering({ approved: false }));
    expect(err.byUser).toBe(true);
    expect(err.message).toBe(
      "The user declined this os.fs.write call (they pressed Deny). " +
        "This was their decision, not an error or a policy block. " +
        "Do not retry it or try another way to do the same thing; " +
        "tell the user it was not done and ask what they would like instead.",
    );
    expect(err.message).not.toMatch(/approval denied/);
  });

  it("typed words instead of Deny are passed on as what the user said, last", async () => {
    const err = await denialOf(
      answering({ approved: false, reason: "put it in ~/Documents instead" }),
    );
    expect(err.byUser).toBe(true);
    expect(err.reason).toBe("put it in ~/Documents instead");
    expect(err.message).toBe(
      "The user declined this os.fs.write call. " +
        "This was their decision, not an error or a policy block. " +
        "Do not run the same call again; go by what they said. " +
        "The user said: put it in ~/Documents instead",
    );
  });

  it("a denial nobody decided says so and never claims the user declined", async () => {
    const err = await denialOf(
      answering({
        approved: false,
        automatic: true,
        reason: "the approval prompt timed out with no answer",
      }),
    );
    expect(err.byUser).toBe(false);
    expect(err.message).toBe(
      "os.fs.write was not run: refused without a decision from the user. " +
        "Reason: the approval prompt timed out with no answer",
    );
    expect(err.message).not.toContain("declined");
  });

  it("a prompt dropped because its surface stopped watching is not the user's no", async () => {
    const gate = new ApprovalGate({ level: 1, emit: () => undefined });
    const pending = denialOf(gate);
    // The request is parked by the time the microtask queue drains.
    await Promise.resolve();
    expect(gate.denyPendingForSession("s-1", "the operator switched away")).toBe(1);
    const err = await pending;
    expect(err.byUser).toBe(false);
    expect(err.message).toContain("Reason: the operator switched away");
    expect(err.message).not.toContain("declined");
  });

  it("describes an automatic denial without a reason in one sentence", () => {
    expect(describeApprovalDenial("os.shell.run", undefined, false)).toBe(
      "os.shell.run was not run: refused without a decision from the user.",
    );
    // Blank words are no words.
    expect(describeApprovalDenial("os.shell.run", "  ", true)).toContain(
      "(they pressed Deny)",
    );
  });

  it("a repeat of what the user declined earlier in the turn says so, not that the system refused it", () => {
    const err = new ApprovalDeniedError("os.shell.run", "this same call", {
      declinedEarlier: true,
    });
    expect(err.byUser).toBe(false);
    expect(err.declinedEarlier).toBe(true);
    expect(err.message).toBe(
      "os.shell.run was not run: the user already declined this same call " +
        "earlier in this turn, so it was not asked again. " +
        "Do not try it again or another way; " +
        "tell the user it was not done and ask what they would like instead.",
    );
    expect(err.message).not.toContain("without a decision");
  });

  it("an error built without saying who decided never claims the user did", () => {
    const err = new ApprovalDeniedError("os.fs.write", "no surface");
    expect(err.byUser).toBe(false);
    expect(err.name).toBe("ApprovalDeniedError");
    expect(err.message).not.toContain("declined");
  });
});
