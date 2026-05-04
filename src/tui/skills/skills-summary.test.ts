import { describe, expect, it } from "vitest";
import type { SkillRecord } from "../../skills/skill-loader.js";
import {
  SKILL_SUMMARY_DESCRIPTION_MAX_CHARS,
  toSkillSummaryRow,
  toSkillSummaryRows,
} from "./skills-summary.js";

function makeRecord(
  overrides: Partial<SkillRecord["manifest"]> = {},
  source: SkillRecord["source"] = "global",
): SkillRecord {
  return {
    manifest: {
      name: "alpha",
      description: "Skill alpha",
      version: "0.1.0",
      requiresTools: [],
      requiresScripts: [],
      dangerous: false,
      ...overrides,
    },
    body: "body",
    manifestPath: "/tmp/alpha/SKILL.md",
    skillDir: "/tmp/alpha",
    source,
  };
}

describe("toSkillSummaryRow", () => {
  it("plumbs the disabled flag through", () => {
    const row = toSkillSummaryRow(makeRecord(), true);
    expect(row.disabled).toBe(true);
    expect(row.name).toBe("alpha");
  });

  it("collapses multi-line descriptions to a single line", () => {
    const row = toSkillSummaryRow(
      makeRecord({ description: "line one\n\n  line   two" }),
      false,
    );
    expect(row.description).toBe("line one line two");
  });

  it("truncates long descriptions to the cap", () => {
    const long = "x".repeat(SKILL_SUMMARY_DESCRIPTION_MAX_CHARS + 50);
    const row = toSkillSummaryRow(makeRecord({ description: long }), false);
    expect(row.description.length).toBe(SKILL_SUMMARY_DESCRIPTION_MAX_CHARS);
    expect(row.description.endsWith("…")).toBe(true);
  });
});

describe("toSkillSummaryRows", () => {
  it("maps SkillRegistry.listAll() output in one pass", () => {
    const rows = toSkillSummaryRows([
      { record: makeRecord({ name: "alpha" }), disabled: false },
      { record: makeRecord({ name: "beta" }, "project"), disabled: true },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("alpha");
    expect(rows[1]?.disabled).toBe(true);
    expect(rows[1]?.source).toBe("project");
  });
});
