import { describe, expect, it } from "vitest";

import {
  approvalLevelAllows,
  formatRunTime,
  remainingCostUsd,
  remainingDurationMs,
  validateMaxCostUsd,
  validateMaxDurationMs,
  validateApprovalLevel,
} from "./task-budget.js";
import { TaskValidationError } from "./task-types.js";

describe("task budget rules", () => {
  it("leaves a task without its own ceiling to config", () => {
    expect(remainingCostUsd({ maxCostUsd: null, spentUsd: 4 })).toBeUndefined();
  });

  it("gives what earlier attempts left, and says when nothing is left", () => {
    expect(remainingCostUsd({ maxCostUsd: 2, spentUsd: null })).toBe(2);
    expect(remainingCostUsd({ maxCostUsd: 2, spentUsd: 0.5 })).toBe(1.5);
    expect(remainingCostUsd({ maxCostUsd: 2, spentUsd: 2 })).toBe("exhausted");
    expect(remainingCostUsd({ maxCostUsd: 2, spentUsd: 2.4 })).toBe("exhausted");
  });

  it("treats the time limit the same way", () => {
    expect(remainingDurationMs({ maxDurationMs: null, elapsedMs: 5 })).toBeUndefined();
    expect(remainingDurationMs({ maxDurationMs: 100, elapsedMs: null })).toBe(100);
    expect(remainingDurationMs({ maxDurationMs: 100, elapsedMs: 70 })).toBe(30);
    expect(remainingDurationMs({ maxDurationMs: 100, elapsedMs: 100 })).toBe("exhausted");
    expect(remainingDurationMs({ maxDurationMs: 100, elapsedMs: 130 })).toBe("exhausted");
  });

  it("spells a run time in minutes, then hours", () => {
    expect(formatRunTime(45 * 60_000)).toBe("45 min");
    expect(formatRunTime(8 * 3_600_000)).toBe("8 h");
    expect(formatRunTime(90 * 60_000)).toBe("90 min");
  });

  it("validates the budget inputs", () => {
    expect(validateMaxCostUsd(undefined)).toBeNull();
    expect(validateMaxCostUsd(null)).toBeNull();
    expect(validateMaxCostUsd(0.5)).toBe(0.5);
    expect(() => validateMaxCostUsd(0)).toThrow(TaskValidationError);
    expect(validateMaxDurationMs(undefined)).toBeNull();
    expect(validateMaxDurationMs(60_000)).toBe(60_000);
    expect(() => validateMaxDurationMs(-1)).toThrow(TaskValidationError);
  });

  it("keeps a recorded approval level to processes at that level (ATO-1324)", () => {
    expect(validateApprovalLevel(undefined)).toBeNull();
    expect(validateApprovalLevel(3)).toBe(3);
    expect(() => validateApprovalLevel(0)).toThrow(TaskValidationError);
    expect(() => validateApprovalLevel(6)).toThrow(TaskValidationError);
    expect(() => validateApprovalLevel(2.5)).toThrow(TaskValidationError);
    expect(approvalLevelAllows({ approvalLevel: null }, 5)).toBe(true);
    expect(approvalLevelAllows({}, 1)).toBe(true);
    expect(approvalLevelAllows({ approvalLevel: 2 }, 2)).toBe(true);
    expect(approvalLevelAllows({ approvalLevel: 2 }, 5)).toBe(false);
    expect(approvalLevelAllows({ approvalLevel: 5 }, 2)).toBe(false);
    expect(approvalLevelAllows({ approvalLevel: 2 }, undefined)).toBe(true);
  });
});
