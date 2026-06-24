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

  it("skips apple-* starters on linux but keeps cross-platform ones", async () => {
    const result = await seedStarterSkillsIfMissing({
      globalSkillsDir: globalDir,
      platform: "linux",
    });
    expect(result.installed).toContain("skill-creator");
    expect(result.installed).not.toContain("apple-notes");
    expect(result.installed).not.toContain("apple-reminders");
    expect(result.installed).not.toContain("apple-calendar");
    expect(existsSync(join(globalDir, "apple-notes"))).toBe(false);
  });

  it("seeds apple-* starters on darwin", async () => {
    const result = await seedStarterSkillsIfMissing({
      globalSkillsDir: globalDir,
      platform: "darwin",
    });
    expect(result.installed).toContain("apple-notes");
    expect(existsSync(join(globalDir, "apple-notes", "SKILL.md"))).toBe(true);
  });

  it("prunes tombstoned starter skills and is idempotent", async () => {
    const staleDdgrPath = join(globalDir, "ddgr-web-search");
    const staleExaPath = join(globalDir, "exa-web-search");
    mkdirSync(staleDdgrPath, { recursive: true });
    mkdirSync(staleExaPath, { recursive: true });
    writeFileSync(join(staleDdgrPath, "SKILL.md"), "old ddgr skill", "utf8");
    writeFileSync(join(staleExaPath, "SKILL.md"), "old exa skill", "utf8");

    const first = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(first.removed).toContain("ddgr-web-search");
    expect(first.removed).toContain("exa-web-search");
    expect(existsSync(staleDdgrPath)).toBe(false);
    expect(existsSync(staleExaPath)).toBe(false);

    const second = await seedStarterSkillsIfMissing({ globalSkillsDir: globalDir });
    expect(second.removed).not.toContain("ddgr-web-search");
    expect(second.removed).not.toContain("exa-web-search");
  });
});
