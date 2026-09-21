import { describe, it, expect } from "vitest";

import {
  buildSkillCatalog,
  buildSkillCatalogSection,
  formatSkillCatalogLine,
  formatSkillCatalogOmittedLine,
  DEFAULT_CATALOG_MAX_CHARS,
  SKILL_CATALOG_CHARS_PER_TOKEN,
} from "./skill-catalog.js";
import { ENV_DEFAULTS } from "../config/config-schema.js";
import type { SkillRecord } from "./skill-loader.js";

function record(
  name: string,
  description: string,
  source: SkillRecord["source"] = "global",
): SkillRecord {
  return {
    manifest: {
      name,
      description,
      version: "1.0.0",
      requiresTools: [],
      requiresScripts: [],
      dangerous: false,
    },
    rootDir: `/tmp/${name}`,
    manifestPath: `/tmp/${name}/SKILL.md`,
    source,
  };
}

describe("buildSkillCatalog", () => {
  it("formats lines like stable prefix ### skills (tag + name + description)", () => {
    const line = formatSkillCatalogLine({
      name: "a-skill",
      description: "does a thing",
      source: "global",
    });
    expect(line).toBe("- [global] a-skill: does a thing");
    const proj = formatSkillCatalogLine({
      name: "b-skill",
      description: "x",
      source: "project",
    });
    expect(proj).toBe("- [project] b-skill: x");
  });

  it("accounts for join newlines and tags when applying maxChars", () => {
    const records = [record("first", "one"), record("second", "two")];
    const catalog = buildSkillCatalog(records, {
      maxChars:
        formatSkillCatalogLine({
          name: "first",
          description: "one",
          source: "global",
        }).length +
        1 +
        formatSkillCatalogLine({
          name: "second",
          description: "two",
          source: "global",
        }).length,
    });
    expect(catalog).toHaveLength(2);
    const tight = buildSkillCatalog(records, {
      maxChars:
        formatSkillCatalogLine({
          name: "first",
          description: "one",
          source: "global",
        }).length + 1,
    });
    expect(tight).toHaveLength(1);
    expect(tight[0]?.name).toBe("first");
  });

  it("honors tokenBudget: a raised budget keeps entries the default cap drops", () => {
    // Ten records of ~600 rendered chars each (~6000 chars total):
    // overflowing the default 4096-char cap but fitting in 1024 tokens
    // (8192 chars).
    const records = Array.from({ length: 10 }, (_, i) =>
      record(`skill-${i}`, "d".repeat(580)),
    );
    const byDefault = buildSkillCatalog(records);
    expect(byDefault.length).toBeLessThan(records.length);

    const raised = buildSkillCatalog(records, { tokenBudget: 1024 });
    expect(raised.length).toBeGreaterThan(byDefault.length);
    expect(raised.length).toBe(records.length);
  });

  it("shipped default budget maps to the historical 4096-char cap", () => {
    // Import the real shipped default so a drive-by change to either the
    // default or the chars/token factor trips this guard.
    expect(
      ENV_DEFAULTS.SKILLS_CATALOG_BUDGET * SKILL_CATALOG_CHARS_PER_TOKEN,
    ).toBe(DEFAULT_CATALOG_MAX_CHARS);

    // A record set sized to straddle the 4096-char boundary must be cut
    // at the same entry whether the caller passes nothing (legacy
    // hardcoded cap) or the shipped config default.
    const records = Array.from({ length: 12 }, (_, i) =>
      record(`skill-${i}`, "d".repeat(390)),
    );
    const legacy = buildSkillCatalog(records);
    const configured = buildSkillCatalog(records, {
      tokenBudget: ENV_DEFAULTS.SKILLS_CATALOG_BUDGET,
    });
    expect(configured).toEqual(legacy);
    expect(legacy.length).toBeLessThan(records.length);
  });

  /**
   * Issue #466. The catalog cut silently: 33 installed skills rendered
   * to ~7900 chars, the 4096-char default showed 17 of them, and nothing
   * in the prompt said the other 16 existed — so the model answered "no
   * such skill" for skills that were installed and loadable.
   */
  describe("the truncation marker", () => {
    it("reports the real dropped count, and none when everything fits", () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        record(`skill-${i}`, "d".repeat(580)),
      );
      const whole = buildSkillCatalogSection(records, { tokenBudget: 1024 });
      expect(whole.entries).toHaveLength(records.length);
      expect(whole.dropped).toBe(0);

      const cut = buildSkillCatalogSection(records);
      expect(cut.entries.length).toBeLessThan(records.length);
      expect(cut.dropped).toBe(records.length - cut.entries.length);
      expect(formatSkillCatalogOmittedLine(cut.dropped)).toContain(
        "skills.catalogTokenBudget",
      );
    });

    it("counts against the budget: the section still fits with the marker", () => {
      // Four equal-length rows against a budget that holds exactly
      // three of them — so the entries the plain cut keeps leave not one
      // byte for a marker, and the packer has to give a row back.
      const records = Array.from({ length: 4 }, (_, i) =>
        record(`skill-${i}`, "d".repeat(100)),
      );
      const lineLength = formatSkillCatalogLine({
        name: "skill-0",
        description: "d".repeat(100),
        source: "global",
      }).length;
      // Three rows and the two newlines between them, to the byte —
      // which is what the plain first-overflow cut used to keep.
      const maxChars = lineLength * 3 + 2;

      const cut = buildSkillCatalogSection(records, { maxChars });
      expect(cut.entries).toHaveLength(2);
      expect(cut.dropped).toBe(2);
      const rendered = [
        ...cut.entries.map(formatSkillCatalogLine),
        formatSkillCatalogOmittedLine(cut.dropped),
      ].join("\n");
      expect(rendered.length).toBeLessThanOrEqual(maxChars);
    });

    it("a catalog that only just fits gets no marker and no lost entry", () => {
      const records = [record("first", "one"), record("second", "two")];
      const exact =
        formatSkillCatalogLine({
          name: "first",
          description: "one",
          source: "global",
        }).length +
        1 +
        formatSkillCatalogLine({
          name: "second",
          description: "two",
          source: "global",
        }).length;
      const section = buildSkillCatalogSection(records, { maxChars: exact });
      expect(section.entries).toHaveLength(2);
      expect(section.dropped).toBe(0);
    });

    it("singular for one dropped skill", () => {
      expect(formatSkillCatalogOmittedLine(1)).toContain("1 more installed skill ");
      expect(formatSkillCatalogOmittedLine(2)).toContain("2 more installed skills ");
    });
  });

  it("explicit maxChars wins over tokenBudget", () => {
    const records = [record("first", "one"), record("second", "two")];
    const firstLine = formatSkillCatalogLine({
      name: "first",
      description: "one",
      source: "global",
    });
    const catalog = buildSkillCatalog(records, {
      maxChars: firstLine.length + 1,
      tokenBudget: 1024,
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe("first");
  });
});
