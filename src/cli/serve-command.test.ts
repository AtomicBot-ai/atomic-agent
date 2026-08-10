import { describe, expect, it } from "vitest";

import { resolveServeApprovalRequired } from "./serve-command.js";

describe("resolveServeApprovalRequired", () => {
  it("matches the run/tui boot contract: persisted flag is the baseline", () => {
    // Persisted agent.approvalRequired=true, no flag: approvals stay on.
    expect(resolveServeApprovalRequired(false, true)).toBe(true);
    // The Privacy-tab toggle persisted false: serve must honor it, the
    // panel promises "applies to future runs too".
    expect(resolveServeApprovalRequired(false, false)).toBe(false);
  });

  it("--no-approval can only force approvals off, never back on", () => {
    expect(resolveServeApprovalRequired(true, true)).toBe(false);
    expect(resolveServeApprovalRequired(true, false)).toBe(false);
  });
});
