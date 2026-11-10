import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_DEADLINE_REPEAT_MS,
  APPROVAL_TIME_LIMIT_REASON,
  armApprovalDeadline,
} from "./approval-deadline.js";

describe("armApprovalDeadline (ATO-1367)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("denies pending prompts once the time is up, and keeps denying until the step ends", () => {
    vi.useFakeTimers();
    const deny = vi.fn();
    const dispose = armApprovalDeadline({ msLeft: 30_000, deny });
    vi.advanceTimersByTime(29_999);
    expect(deny).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deny).toHaveBeenCalledTimes(1);
    expect(deny).toHaveBeenCalledWith(APPROVAL_TIME_LIMIT_REASON);
    vi.advanceTimersByTime(APPROVAL_DEADLINE_REPEAT_MS * 2);
    expect(deny).toHaveBeenCalledTimes(3);
    dispose();
    vi.advanceTimersByTime(APPROVAL_DEADLINE_REPEAT_MS * 4);
    expect(deny).toHaveBeenCalledTimes(3);
  });

  it("never fires for a step that ends before the limit", () => {
    vi.useFakeTimers();
    const deny = vi.fn();
    const dispose = armApprovalDeadline({ msLeft: 10_000, deny });
    vi.advanceTimersByTime(5_000);
    dispose();
    vi.advanceTimersByTime(60_000);
    expect(deny).not.toHaveBeenCalled();
  });

  it("fires at once when the limit already passed, and survives a throwing gate", () => {
    vi.useFakeTimers();
    const deny = vi.fn(() => {
      throw new Error("gate down");
    });
    const dispose = armApprovalDeadline({ msLeft: -5, deny });
    vi.advanceTimersByTime(0);
    expect(deny).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does nothing without a finite limit", () => {
    vi.useFakeTimers();
    const deny = vi.fn();
    armApprovalDeadline({ msLeft: Number.POSITIVE_INFINITY, deny })();
    vi.advanceTimersByTime(1e9);
    expect(deny).not.toHaveBeenCalled();
  });
});
