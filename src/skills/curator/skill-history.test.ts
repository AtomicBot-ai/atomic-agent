import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSkill,
  listSkillVersions,
  restoreSkill,
  snapshotSkill,
  versionId,
  type SkillHistoryDirs,
} from "./skill-history.js";

function writeSkill(skillsDir: string, name: string, body: string): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), body, "utf8");
}

function readSkill(skillsDir: string, name: string): string {
  return readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
}

describe("skill history", () => {
  let root: string;
  let dirs: SkillHistoryDirs;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-skill-history-"));
    dirs = {
      skillsDir: join(root, "skills"),
      historyDir: join(root, "skills-history"),
      archiveDir: join(root, "skills-archive"),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("version ids sort by time", () => {
    expect(versionId(Date.UTC(2026, 10, 12, 10, 15, 0, 123))).toBe("20261112T101500123Z");
  });

  it("returns null when there is no folder to snapshot", async () => {
    expect(await snapshotSkill(dirs, "missing", 1)).toBeNull();
  });

  it("keeps at most 10 snapshots per skill, dropping the oldest", async () => {
    writeSkill(dirs.skillsDir, "alpha", "v0");
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      writeSkill(dirs.skillsDir, "alpha", `v${i}`);
      ids.push((await snapshotSkill(dirs, "alpha", Date.UTC(2026, 0, 1) + i * 1000))!);
    }
    const versions = await listSkillVersions(dirs.historyDir, "alpha");
    expect(versions).toHaveLength(10);
    expect(versions).toEqual(ids.slice(3));
    expect(readFileSync(join(dirs.historyDir, "alpha", versions[0]!, "SKILL.md"), "utf8")).toBe("v3");
  });

  it("gives two snapshots in the same millisecond distinct ids", async () => {
    writeSkill(dirs.skillsDir, "alpha", "one");
    const a = await snapshotSkill(dirs, "alpha", 42);
    const b = await snapshotSkill(dirs, "alpha", 42);
    expect(a).not.toBe(b);
    expect(await listSkillVersions(dirs.historyDir, "alpha")).toEqual([a, b]);
  });

  it("restores a chosen version and saves the current copy first", async () => {
    writeSkill(dirs.skillsDir, "alpha", "good");
    const good = (await snapshotSkill(dirs, "alpha", 1_000))!;
    writeSkill(dirs.skillsDir, "alpha", "broken");
    const result = await restoreSkill(dirs, "alpha", good, 2_000);
    expect(result.restoredFrom).toBe(good);
    expect(readSkill(dirs.skillsDir, "alpha")).toBe("good");
    expect(result.snapshot).not.toBeNull();
    expect(readFileSync(join(dirs.historyDir, "alpha", result.snapshot!, "SKILL.md"), "utf8")).toBe("broken");
  });

  it("restores the newest version when none is named", async () => {
    writeSkill(dirs.skillsDir, "alpha", "first");
    await snapshotSkill(dirs, "alpha", 1_000);
    writeSkill(dirs.skillsDir, "alpha", "second");
    await snapshotSkill(dirs, "alpha", 2_000);
    rmSync(join(dirs.skillsDir, "alpha"), { recursive: true });
    const result = await restoreSkill(dirs, "alpha", undefined, 3_000);
    expect(result.snapshot).toBeNull();
    expect(readSkill(dirs.skillsDir, "alpha")).toBe("second");
  });

  it("archives by moving, and restore brings the archived copy back", async () => {
    writeSkill(dirs.skillsDir, "alpha", "kept");
    await archiveSkill(dirs, "alpha", 1_000);
    expect(existsSync(join(dirs.skillsDir, "alpha"))).toBe(false);
    expect(readFileSync(join(dirs.archiveDir, "alpha", "SKILL.md"), "utf8")).toBe("kept");
    const result = await restoreSkill(dirs, "alpha", undefined, 2_000);
    expect(result.restoredFrom).toBe("archive");
    expect(readSkill(dirs.skillsDir, "alpha")).toBe("kept");
    expect(existsSync(join(dirs.archiveDir, "alpha"))).toBe(false);
  });

  it("refuses unknown versions and names that could leave the folder", async () => {
    writeSkill(dirs.skillsDir, "alpha", "x");
    await expect(restoreSkill(dirs, "alpha", "20990101T000000000Z")).rejects.toThrow(/no version/);
    await expect(restoreSkill(dirs, "alpha", "../../etc")).rejects.toThrow(/not a version id/);
    await expect(restoreSkill(dirs, "..", undefined)).rejects.toThrow(/not a skill folder name/);
    await expect(restoreSkill(dirs, "ghost", "archive")).rejects.toThrow(/not in the archive/);
  });
});
