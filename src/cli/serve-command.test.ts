import { describe, expect, it } from "vitest";

import { resolveBootApprovalLevel } from "../approval/approval-level.js";

// `serve` shares the boot contract with `run` and `tui` by calling the
// same resolver; this test pins the contract at serve's import site.
describe("serve boot approval level (resolveBootApprovalLevel)", () => {
  it("matches the run/tui boot contract: persisted level is the baseline", () => {
    // Persisted agent.approvalLevel=1, no flag: everything still asks.
    expect(resolveBootApprovalLevel(false, 1)).toBe(1);
    // The Privacy-tab ladder persisted 3: serve must honor it, the
    // panel promises "applies to future runs too".
    expect(resolveBootApprovalLevel(false, 3)).toBe(3);
  });

  it("--no-approval can only force level 5, never a stricter level", () => {
    expect(resolveBootApprovalLevel(true, 1)).toBe(5);
    expect(resolveBootApprovalLevel(true, 5)).toBe(5);
  });
});
