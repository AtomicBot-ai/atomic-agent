import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSkillDirs, PiSource } from "./pi-source.js";

const SKILL_MD = "---\nname: sample\ndescription: A sample skill\n---\nBody\n";

describe("PiSource", () => {
  let sourceDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "pi-src-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function seedSkill(...segments: string[]): void {
    const dir = join(sourceDir, "skills", ...segments);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
  }

  it("lists nothing when the skills dir is missing", () => {
    expect(new PiSource(sourceDir).listSkills()).toEqual([]);
    expect(new PiSource(sourceDir).hasSkills()).toBe(false);
  });

  it("discovers skills recursively, but never inside a skill dir", () => {
    seedSkill("triage");
    seedSkill("group", "nested");
    // Resources inside a skill dir are not skills of their own.
    seedSkill("triage", "resources");
    // A loose root-level markdown skill (Pi extension) is not a dir.
    writeFileSync(join(sourceDir, "skills", "loose.md"), SKILL_MD);

    const skills = new PiSource(sourceDir).listSkills();
    expect(skills.map((s) => s.name)).toEqual(["group/nested", "triage"]);
    expect(skills[0]!.dir).toBe(join(sourceDir, "skills", "group", "nested"));
  });
});

describe("listSkillDirs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-skilldirs-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("scans one level only when recursive is off", () => {
    mkdirSync(join(root, "top"), { recursive: true });
    writeFileSync(join(root, "top", "SKILL.md"), SKILL_MD);
    mkdirSync(join(root, "group", "deep"), { recursive: true });
    writeFileSync(join(root, "group", "deep", "SKILL.md"), SKILL_MD);

    expect(
      listSkillDirs(root, { recursive: false }).map((s) => s.name),
    ).toEqual(["top"]);
    expect(listSkillDirs(root, { recursive: true }).map((s) => s.name)).toEqual(
      ["group/deep", "top"],
    );
  });
});
