import { describe, expect, it } from "vitest";
import { buildReport, emptySummary, type ImportItemResult } from "./import-report.js";

describe("emptySummary", () => {
  it("starts every status at zero", () => {
    expect(emptySummary()).toEqual({
      migrated: 0,
      skipped: 0,
      conflict: 0,
      error: 0,
    });
  });
});

describe("buildReport", () => {
  it("aggregates item statuses into a summary", () => {
    const items: ImportItemResult[] = [
      { kind: "sessions", status: "migrated" },
      { kind: "sessions", status: "skipped" },
      { kind: "cron", status: "conflict" },
      { kind: "secrets", status: "error" },
      { kind: "cron", status: "migrated" },
    ];
    const report = buildReport(items, true);
    expect(report.summary).toEqual({
      migrated: 2,
      skipped: 1,
      conflict: 1,
      error: 1,
    });
    expect(report.executed).toBe(true);
    expect(report.items).toHaveLength(5);
  });

  it("marks executed=false for previews", () => {
    expect(buildReport([], false).executed).toBe(false);
  });
});
