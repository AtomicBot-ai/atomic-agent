import { describe, it, expect } from "vitest";

import {
  buildSkillCatalog,
  formatSkillCatalogLine,
  DEFAULT_CATALOG_MAX_CHARS,
  SKILL_CATALOG_CHARS_PER_TOKEN,
} from "./skill-catalog.js";
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
    const records = [
      record("first", "one"),
      record("second", "two"),
    ];
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

  it("shipped default budget of 512 tokens maps to the historical 4096-char cap", () => {
    expect(512 * SKILL_CATALOG_CHARS_PER_TOKEN).toBe(DEFAULT_CATALOG_MAX_CHARS);

    // A record set sized to straddle the 4096-char boundary must be cut
    // at the same entry whether the caller passes nothing (legacy
    // hardcoded cap) or the shipped config default of 512 tokens.
    const records = Array.from({ length: 12 }, (_, i) =>
      record(`skill-${i}`, "d".repeat(390)),
    );
    const legacy = buildSkillCatalog(records);
    const configured = buildSkillCatalog(records, { tokenBudget: 512 });
    expect(configured).toEqual(legacy);
    expect(legacy.length).toBeLessThan(records.length);
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
