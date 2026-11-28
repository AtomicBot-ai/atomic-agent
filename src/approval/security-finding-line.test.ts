import { describe, expect, it } from "vitest";
import { ApprovalGate } from "./approval-gate.js";
import { runWithApprovalLedger, type ToolApprovalRecord } from "./approval-ledger.js";
import { requireApproval } from "./dangerous-tool.js";
import { formatSecurityFindingLine } from "./security-finding-line.js";

const finding = { rule: "dangerous.read_credentials", reason: "reads ~/.ssh/id_rsa", confidence: 0.9 };

describe("formatSecurityFindingLine (ATO-2505)", () => {
  it("says what was found, how sure, and that it asks in every mode", () => {
    expect(formatSecurityFindingLine({ securityFinding: finding, askEveryLevel: true })).toBe(
      "security check: reads ~/.ssh/id_rsa, 90% sure; asks in every mode",
    );
  });

  it("leaves out the every-mode note below the threshold, and is null without a finding", () => {
    expect(formatSecurityFindingLine({ securityFinding: { ...finding, confidence: 0.6 } })).toBe(
      "security check: reads ~/.ssh/id_rsa, 60% sure",
    );
    expect(formatSecurityFindingLine({})).toBeNull();
  });

  it("keeps the line on one line", () => {
    const line = formatSecurityFindingLine({ securityFinding: { ...finding, reason: "a\nb" } });
    expect(line).not.toContain("\n");
  });
});

describe("the ledger keeps the finding with the answer (ATO-2505)", () => {
  it.each([true, false])("records the finding when approved=%s", async (approved) => {
    const gate: ApprovalGate = new ApprovalGate({
      level: 1,
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved, reason: "x" }),
    });
    const ledger: ToolApprovalRecord[] = [];
    await runWithApprovalLedger(ledger, () =>
      requireApproval(
        { approvals: gate, approvalRequired: true },
        { sessionId: "s", tool: "os.shell.run", category: "shell_dangerous", reason: "r", securityFinding: finding },
        new AbortController().signal,
      ).catch(() => ({})),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ verdict: approved ? "approved" : "denied", finding });
  });
});
