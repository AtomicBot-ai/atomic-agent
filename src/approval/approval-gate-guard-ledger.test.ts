import { describe, expect, it } from "vitest";
import { ApprovalGate } from "./approval-gate.js";
import { runWithApprovalLedger, type ToolApprovalRecord } from "./approval-ledger.js";
import { requireApproval, requireGuardOnShortcut } from "./dangerous-tool.js";
import type { SecurityGuard } from "./guard-check.js";

/**
 * ATO-2529: a call the security rules refused left nothing on the
 * approval ledger, so the turn summary could not say why it did not run.
 * Both paths (the gate and a tool's shortcut) now record a `guard` entry.
 */
function guard(verdict: { decision: "allow" | "block"; reason: string } | null, onFailure: "ask" | "block" = "ask"): SecurityGuard {
  return {
    rules: () => ({ sets: [{ source: "user", rules: "No reading my notes." }], tools: new Set(["os.shell.run"]), onFailure }),
    review: async () => verdict,
  };
}

const prompt = { sessionId: "s", tool: "os.shell.run", category: "shell" as const, reason: "cat notes", preview: "cat notes" };

async function ledgerOf(gate: ApprovalGate, call: (g: ApprovalGate) => Promise<unknown>): Promise<ToolApprovalRecord[]> {
  const ledger: ToolApprovalRecord[] = [];
  await runWithApprovalLedger(ledger, () => call(gate).catch(() => undefined));
  return ledger;
}

describe("security rules refusals on the ledger (ATO-2529)", () => {
  it("records a block in the gate", async () => {
    const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    gate.setGuard(guard({ decision: "block", reason: "reads private notes" }));
    const ledger = await ledgerOf(gate, (g) =>
      requireApproval({ approvals: g, approvalRequired: true }, prompt, new AbortController().signal),
    );
    expect(ledger).toEqual([
      expect.objectContaining({ verdict: "denied", category: "shell", guard: { decision: "block", reason: "reads private notes" } }),
    ]);
  });

  it("records a block on a shortcut, and a no-answer under onFailure: block", async () => {
    const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    gate.setGuard(guard({ decision: "block", reason: "reads private notes" }));
    const call = (g: ApprovalGate) =>
      requireGuardOnShortcut({ approvals: g, approvalRequired: true }, prompt, new AbortController().signal);
    expect((await ledgerOf(gate, call))[0]?.guard).toEqual({ decision: "block", reason: "reads private notes" });
    gate.setGuard(guard(null, "block"));
    expect((await ledgerOf(gate, call))[0]?.guard?.decision).toBe("no-answer");
  });

  it("records nothing for an allow", async () => {
    const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    gate.setGuard(guard({ decision: "allow", reason: "" }));
    const call = (g: ApprovalGate) =>
      requireGuardOnShortcut({ approvals: g, approvalRequired: true }, prompt, new AbortController().signal);
    expect(await ledgerOf(gate, call)).toEqual([]);
  });
});
