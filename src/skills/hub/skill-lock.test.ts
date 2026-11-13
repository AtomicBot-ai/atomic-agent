import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeSkillDigest,
  readSkillLock,
  removeSkillLock,
  SKILL_LOCK_FILE,
  writeSkillLock,
  type SkillLock,
} from "./skill-lock.js";

const LOCK: SkillLock = {
  schema: 1,
  source: "github",
  identifier: "o/r/demo",
  version: "a".repeat(40),
  revision: "b".repeat(40),
  digest: "sha256-x",
  scanId: "id",
  verdict: "ok",
  installedAt: "2026-11-12T00:00:00.000Z",
};

describe("skill lock", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-skill-lock-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function makeDir(name: string, files: Record<string, string>): Promise<string> {
    const dir = join(base, name);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), content, "utf8");
    }
    return dir;
  }

  it("gives the same digest for the same files in any folder", async () => {
    const files = { "SKILL.md": "a", "scripts/run.sh": "echo hi" };
    const a = await computeSkillDigest(await makeDir("a", files));
    const b = await computeSkillDigest(await makeDir("b", files));
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("changes when a file's content, a file name or a new file changes", async () => {
    const original = await computeSkillDigest(await makeDir("o", { "SKILL.md": "a", "x.txt": "1" }));
    const edited = await computeSkillDigest(await makeDir("e", { "SKILL.md": "a", "x.txt": "2" }));
    const renamed = await computeSkillDigest(await makeDir("r", { "SKILL.md": "a", "y.txt": "1" }));
    const added = await computeSkillDigest(await makeDir("n", { "SKILL.md": "a", "x.txt": "1", "z": "" }));
    expect(new Set([original, edited, renamed, added]).size).toBe(4);
  });

  it("ignores the lock file itself but not a nested file with the same name", async () => {
    const dir = await makeDir("d", { "SKILL.md": "a" });
    const before = await computeSkillDigest(dir);
    await writeSkillLock(dir, LOCK);
    expect(await computeSkillDigest(dir)).toBe(before);
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", SKILL_LOCK_FILE), "{}");
    expect(await computeSkillDigest(dir)).not.toBe(before);
  });

  it("covers symlinks by their link text", async () => {
    const a = await makeDir("la", { "SKILL.md": "a" });
    const b = await makeDir("lb", { "SKILL.md": "a" });
    await symlink("SKILL.md", join(a, "link"));
    await symlink("other", join(b, "link"));
    expect(await computeSkillDigest(a)).not.toBe(await computeSkillDigest(b));
  });

  it("round-trips a lock and rejects a missing or malformed one", async () => {
    const dir = await makeDir("rt", { "SKILL.md": "a" });
    expect(await readSkillLock(dir)).toBeNull();
    await writeSkillLock(dir, LOCK);
    expect(await readSkillLock(dir)).toEqual(LOCK);
    await writeFile(join(dir, SKILL_LOCK_FILE), JSON.stringify({ ...LOCK, source: "local" }));
    expect(await readSkillLock(dir)).toBeNull();
    await writeFile(join(dir, SKILL_LOCK_FILE), "not json");
    expect(await readSkillLock(dir)).toBeNull();
    await removeSkillLock(dir);
    expect(await readSkillLock(dir)).toBeNull();
  });
});
