import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillChanges } from "./skill-change-log.js";
import { DAY_MS, skillCuratorPaths, type SkillCuratorPaths } from "./skill-curator-config.js";
import { mentionsSkill, readCuratorState, runSkillCurator, selectCuratorActions } from "./skill-curator.js";
import { SkillUsageLedger, type SkillUsageFile } from "./skill-usage-ledger.js";

const NOW = Date.UTC(2026, 10, 12);
const daysAgo = (n: number) => NOW - n * DAY_MS;

function usage(skills: SkillUsageFile["skills"]): SkillUsageFile {
  return { version: 1, skills };
}

describe("selectCuratorActions", () => {
  const base = { starterNames: new Set<string>(), cronTexts: [] as string[], now: NOW };

  it("archives an agent-learned skill unused for 30 days and marks one at 14 days stale", () => {
    const verdicts = selectCuratorActions({
      ...base,
      installed: ["old", "idle", "fresh"],
      usage: usage({
        old: { useCount: 3, lastUsedAt: daysAgo(31), origin: "agent", createdAt: daysAgo(90) },
        idle: { useCount: 1, lastUsedAt: daysAgo(15), origin: "agent", createdAt: daysAgo(40) },
        fresh: { useCount: 0, origin: "agent", createdAt: daysAgo(2) },
      }),
    });
    expect(verdicts).toEqual([
      { name: "fresh", action: "keep", reason: "recently-used" },
      { name: "idle", action: "stale", idleDays: 15 },
      { name: "old", action: "archive", idleDays: 31 },
    ]);
  });

  it("counts a never-used agent skill from the day it was created", () => {
    const [verdict] = selectCuratorActions({
      ...base,
      installed: ["never"],
      usage: usage({ never: { useCount: 0, origin: "agent", createdAt: daysAgo(45) } }),
    });
    expect(verdict).toEqual({ name: "never", action: "archive", idleDays: 45 });
  });

  it("restarts the idle clock after a restore", () => {
    const [verdict] = selectCuratorActions({
      ...base,
      installed: ["back"],
      usage: usage({ back: { useCount: 0, origin: "agent", createdAt: daysAgo(90), restoredAt: daysAgo(1) } }),
    });
    expect(verdict).toEqual({ name: "back", action: "keep", reason: "recently-used" });
  });

  it("never touches starter, hub or hand-written skills however old", () => {
    const verdicts = selectCuratorActions({
      ...base,
      starterNames: new Set(["skill-creator"]),
      installed: ["skill-creator", "from-hub", "handmade"],
      usage: usage({
        // Even a starter that somehow carries an agent origin stays.
        "skill-creator": { useCount: 0, origin: "agent", createdAt: daysAgo(400) },
        "from-hub": { useCount: 1, lastUsedAt: daysAgo(400) },
      }),
    });
    expect(verdicts).toEqual([
      { name: "from-hub", action: "keep", reason: "not-agent-learned" },
      { name: "handmade", action: "keep", reason: "not-agent-learned" },
      { name: "skill-creator", action: "keep", reason: "starter" },
    ]);
  });

  it("keeps a skill a recurring task names", () => {
    const verdicts = selectCuratorActions({
      ...base,
      cronTexts: ["Every Monday use the weekly-report skill and send it to me"],
      installed: ["weekly-report", "weekly"],
      usage: usage({
        "weekly-report": { useCount: 0, origin: "agent", createdAt: daysAgo(60) },
        weekly: { useCount: 0, origin: "agent", createdAt: daysAgo(60) },
      }),
    });
    expect(verdicts).toEqual([
      { name: "weekly", action: "archive", idleDays: 60 },
      { name: "weekly-report", action: "keep", reason: "cron-referenced" },
    ]);
  });

  it("matches skill names as whole words only", () => {
    expect(mentionsSkill("run pdf-tools now", "pdf-tools")).toBe(true);
    expect(mentionsSkill("run pdf-tools-v2 now", "pdf-tools")).toBe(false);
    expect(mentionsSkill("PDF-TOOLS please", "pdf-tools")).toBe(true);
    expect(mentionsSkill("a.b", "a.b")).toBe(true);
    expect(mentionsSkill("axb", "a.b")).toBe(false);
  });
});

describe("runSkillCurator", () => {
  let root: string;
  let skillsDir: string;
  let paths: SkillCuratorPaths;

  const writeSkill = (name: string) => {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "atomic-skill-curator-"));
    skillsDir = join(root, "skills");
    paths = skillCuratorPaths(root);
    writeSkill("old-learned");
    writeSkill("idle-learned");
    writeSkill("starter-one");
    writeSkill("handmade");
    const ledger = new SkillUsageLedger(paths.usageFile);
    await ledger.markAgentCreated("old-learned", daysAgo(50));
    await ledger.markAgentCreated("idle-learned", daysAgo(20));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (extra: Partial<Parameters<typeof runSkillCurator>[0]> = {}) =>
    runSkillCurator({ skillsDir, paths, starterNames: new Set(["starter-one"]), cronTexts: [], now: NOW, ...extra });

  it("moves only the unused agent-learned skill to the archive and logs it", async () => {
    const result = await run();
    expect(result.ran).toBe(true);
    expect(result.archived).toEqual(["old-learned"]);
    expect(result.stale).toEqual(["idle-learned"]);
    expect(existsSync(join(skillsDir, "old-learned"))).toBe(false);
    expect(existsSync(join(paths.archiveDir, "old-learned", "SKILL.md"))).toBe(true);
    for (const kept of ["idle-learned", "starter-one", "handmade"]) expect(existsSync(join(skillsDir, kept))).toBe(true);
    const log = await readSkillChanges(paths.changeLog);
    expect(log.map((e) => [e.name, e.action, e.actor])).toEqual([
      ["old-learned", "archive", "curator"],
      ["idle-learned", "stale", "curator"],
    ]);
    expect(log[0]?.snapshot).toBeDefined();
    expect(await readCuratorState(paths.stateFile)).toEqual({ lastRunAt: NOW, stale: ["idle-learned"] });
  });

  it("runs at most once per 7 days unless forced", async () => {
    await run({ dryRun: false });
    writeSkill("old-learned");
    expect((await run({ now: NOW + 6 * DAY_MS })).ran).toBe(false);
    expect(existsSync(join(skillsDir, "old-learned"))).toBe(true);
    expect((await run({ now: NOW + 6 * DAY_MS, force: true })).ran).toBe(true);
  });

  it("does not log the same stale skill twice in a row", async () => {
    await run();
    await run({ now: NOW + DAY_MS, force: true });
    const stale = (await readSkillChanges(paths.changeLog)).filter((e) => e.action === "stale");
    expect(stale).toHaveLength(1);
  });

  it("dry run reports without moving anything or recording a run", async () => {
    const result = await run({ dryRun: true });
    expect(result.verdicts.find((v) => v.name === "old-learned")?.action).toBe("archive");
    expect(result.archived).toEqual([]);
    expect(existsSync(join(skillsDir, "old-learned"))).toBe(true);
    expect(await readCuratorState(paths.stateFile)).toEqual({ stale: [] });
  });

  it("keeps a learned skill a recurring task names", async () => {
    const result = await run({ cronTexts: ["daily: follow old-learned"] });
    expect(result.archived).toEqual([]);
    expect(existsSync(join(skillsDir, "old-learned"))).toBe(true);
  });
});
