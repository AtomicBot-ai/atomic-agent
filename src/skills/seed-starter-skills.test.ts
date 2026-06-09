import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
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
    expect(first.installed).toContain("skill-creator");

    const hijack = join(globalDir, "skill-creator", "SKILL.md");
    writeFileSync(hijack, "stale-content", "utf8");
    expect(readFileSync(hijack, "utf8")).toBe("stale-content");

    const second = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(second.installed.sort()).toEqual(first.installed.sort());
    expect(readFileSync(hijack, "utf8")).not.toBe("stale-content");
    expect(readFileSync(hijack, "utf8")).toContain("skill-creator");
  });

  it("prunes a tombstoned starter skill (ddgr-web-search) and is idempotent", async () => {
    const stalePath = join(globalDir, "ddgr-web-search");
    mkdirSync(stalePath, { recursive: true });
    writeFileSync(join(stalePath, "SKILL.md"), "old ddgr skill", "utf8");

    const first = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(first.removed).toContain("ddgr-web-search");
    expect(existsSync(stalePath)).toBe(false);

    const second = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(second.removed).not.toContain("ddgr-web-search");
  });
});
