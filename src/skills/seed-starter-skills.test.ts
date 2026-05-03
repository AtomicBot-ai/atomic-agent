import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveStarterSkillsSourceDir,
  seedStarterSkillsIfMissing,
} from "./seed-starter-skills.js";

describe("seedStarterSkillsIfMissing", () => {
  let globalDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "atomic-seed-skills-"));
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("copies starter skill dirs and overwrites on a second run", async () => {
    const source = resolveStarterSkillsSourceDir();
    expect(source).not.toBeNull();

    const first = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(first.sourceDir).toBe(source);
    expect(first.installed.length).toBeGreaterThan(0);
    expect(first.installed).toContain("duckduckgo-search");

    const hijack = join(globalDir, "duckduckgo-search", "SKILL.md");
    writeFileSync(hijack, "stale-content", "utf8");
    expect(readFileSync(hijack, "utf8")).toBe("stale-content");

    const second = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(second.installed.sort()).toEqual(first.installed.sort());
    expect(readFileSync(hijack, "utf8")).not.toBe("stale-content");
    expect(readFileSync(hijack, "utf8")).toContain("duckduckgo-search");
  });
});
