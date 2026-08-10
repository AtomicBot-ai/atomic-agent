import { describe, expect, it } from "vitest";
import {
  APPROVAL_LEVEL_NAMES,
  clampApprovalLevel,
  formatApprovalLevel,
  isAutoApprovedAt,
  resolveBootApprovalLevel,
  type ApprovalCategory,
  type ApprovalLevel,
} from "./approval-level.js";

const LEVELS: readonly ApprovalLevel[] = [1, 2, 3, 4, 5];

describe("approval ladder", () => {
  it("matches the approved category table exactly, level by level", () => {
    // One row per category: the first level at which it goes silent.
    // This is THE product decision — a change here is a behaviour
    // change, not a refactor.
    const silentFrom: Record<ApprovalCategory, ApprovalLevel> = {
      fs_write_workspace: 2,
      fs_write_home: 3,
      fs_trash: 3,
      http: 3,
      shell: 4,
      script: 4,
      proc_kill: 4,
      browser_nonweb: 5,
      other: 5,
    };
    for (const [category, from] of Object.entries(silentFrom) as [
      ApprovalCategory,
      ApprovalLevel,
    ][]) {
      for (const level of LEVELS) {
        expect(
          isAutoApprovedAt(level, category),
          `${category} at level ${level}`,
        ).toBe(level >= from);
      }
    }
  });

  it("level 1 asks for every category and level 5 for none (cumulative ladder)", () => {
    const categories: ApprovalCategory[] = [
      "fs_write_workspace",
      "fs_write_home",
      "fs_trash",
      "http",
      "shell",
      "script",
      "proc_kill",
      "browser_nonweb",
      "other",
    ];
    for (const category of categories) {
      expect(isAutoApprovedAt(1, category)).toBe(false);
      expect(isAutoApprovedAt(5, category)).toBe(true);
      // Cumulative: once silent, silent at every higher level.
      let silent = false;
      for (const level of LEVELS) {
        const now = isAutoApprovedAt(level, category);
        expect(now || !silent).toBe(true);
        silent = silent || now;
      }
    }
  });

  it("clamps arbitrary numbers into [1, 5] and NaN to the strictest level", () => {
    expect(clampApprovalLevel(0)).toBe(1);
    expect(clampApprovalLevel(-7)).toBe(1);
    expect(clampApprovalLevel(1)).toBe(1);
    expect(clampApprovalLevel(3)).toBe(3);
    expect(clampApprovalLevel(3.9)).toBe(3);
    expect(clampApprovalLevel(5)).toBe(5);
    expect(clampApprovalLevel(42)).toBe(5);
    expect(clampApprovalLevel(Number.NaN)).toBe(1);
    expect(clampApprovalLevel(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("names all five levels and formats the canonical label", () => {
    expect(APPROVAL_LEVEL_NAMES[1]).toBe("paranoid");
    expect(APPROVAL_LEVEL_NAMES[2]).toBe("workspace");
    expect(APPROVAL_LEVEL_NAMES[3]).toBe("home");
    expect(APPROVAL_LEVEL_NAMES[4]).toBe("operator");
    expect(APPROVAL_LEVEL_NAMES[5]).toBe("full trust");
    expect(formatApprovalLevel(2)).toBe("2 (workspace)");
  });

  it("--no-approval forces level 5; otherwise the persisted level (clamped) wins", () => {
    expect(resolveBootApprovalLevel(true, 1)).toBe(5);
    expect(resolveBootApprovalLevel(true, 3)).toBe(5);
    expect(resolveBootApprovalLevel(false, 1)).toBe(1);
    expect(resolveBootApprovalLevel(false, 4)).toBe(4);
    expect(resolveBootApprovalLevel(false, 99)).toBe(5);
    expect(resolveBootApprovalLevel(false, 0)).toBe(1);
  });
});
