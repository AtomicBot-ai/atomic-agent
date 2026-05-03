import { describe, it, expect } from "vitest";

import { buildSkillCatalog, formatSkillCatalogLine } from "./skill-catalog.js";
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
});
