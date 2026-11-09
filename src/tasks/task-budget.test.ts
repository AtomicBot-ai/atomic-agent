import { describe, expect, it } from "vitest";

import {
  remainingCostUsd,
  validateMaxCostUsd,
  validateMaxDurationMs,
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

  it("validates the budget inputs", () => {
    expect(validateMaxCostUsd(undefined)).toBeNull();
    expect(validateMaxCostUsd(null)).toBeNull();
    expect(validateMaxCostUsd(0.5)).toBe(0.5);
    expect(() => validateMaxCostUsd(0)).toThrow(TaskValidationError);
    expect(validateMaxDurationMs(undefined)).toBeNull();
    expect(validateMaxDurationMs(60_000)).toBe(60_000);
    expect(() => validateMaxDurationMs(-1)).toThrow(TaskValidationError);
  });
});
