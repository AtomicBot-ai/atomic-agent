import { describe, expect, it, vi } from "vitest";

import { RuntimeApiError } from "./runtime-api-error.js";
import { resolveApproval } from "./approval-service.js";

describe("approval-service", () => {
  it("resolves a pending approval", () => {
    const resolve = vi.fn(() => true);
    const result = resolveApproval(
      { approvals: { resolve } },
      { approvalId: "a-1", approved: true, reason: "ok" },
    );
    expect(resolve).toHaveBeenCalledWith({
      approvalId: "a-1",
      approved: true,
      reason: "ok",
    });
    expect(result).toEqual({ resolved: true, approvalId: "a-1", approved: true });
  });

  it("omits reason when not supplied", () => {
    const resolve = vi.fn(() => true);
    resolveApproval(
      { approvals: { resolve } },
      { approvalId: "a-1", approved: false },
    );
    expect(resolve).toHaveBeenCalledWith({ approvalId: "a-1", approved: false });
  });

  it("throws invalid_request when approvalId is missing", () => {
    const resolve = vi.fn(() => true);
    expect(() =>
      resolveApproval({ approvals: { resolve } }, {
        approvalId: "",
        approved: true,
      }),
    ).toThrow(RuntimeApiError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("throws not_found when the approval is not pending", () => {
    const resolve = vi.fn(() => false);
    try {
      resolveApproval(
        { approvals: { resolve } },
        { approvalId: "stale", approved: true },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as RuntimeApiError).code).toBe("not_found");
    }
  });
});
