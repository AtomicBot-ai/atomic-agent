import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillChanges } from "../curator/skill-change-log.js";
import { skillCuratorPaths, type SkillCuratorPaths } from "../curator/skill-curator-config.js";
import { snapshotSkill } from "../curator/skill-history.js";
import {
  appendLearnedChange,
  learnedJournalFile,
  LearnUndoError,
  readLearnedChanges,
  undoLearnedChange,
} from "./learned-journal.js";
import { formatLearnedList, parseLearnCommand, runLearnCommand } from "./learn-command.js";

describe("learned journal and undo", () => {
  let root: string;
  let skillsDir: string;
  let paths: SkillCuratorPaths;
  let journal: string;

  const write = (name: string, body: string) => {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, "SKILL.md"), body, "utf8");
  };
  const read = (name: string) => readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-learned-journal-"));
    skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    paths = skillCuratorPaths(root);
    journal = learnedJournalFile(paths);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads changes in order, skips bad lines and marks undos", async () => {
    await appendLearnedChange(journal, { id: "aaa111", at: 1, name: "one", action: "create", reason: "first" });
    appendFileSync(journal, "not json\n{\"type\":\"learn\",\"id\":\"x\",\"at\":2,\"name\":\"../up\",\"action\":\"create\"}\n");
    await appendLearnedChange(journal, { id: "bbb222", at: 3, name: "two", action: "patch", snapshot: "20261118T100000000Z", reason: "fix" });
    appendFileSync(journal, `${JSON.stringify({ type: "undo", id: "aaa111", at: 4 })}\n`);
    const entries = await readLearnedChanges(journal);
    expect(entries.map((e) => [e.id, e.undoneAt])).toEqual([["aaa111", 4], ["bbb222", undefined]]);
    expect(entries[1]).toMatchObject({ name: "two", action: "patch", snapshot: "20261118T100000000Z" });
  });

  it("an empty or missing journal is an empty list", async () => {
    expect(await readLearnedChanges(journal)).toEqual([]);
    expect(formatLearnedList([], "/learn undo <id>")).toMatch(/Nothing learned yet/);
  });

  it("undoing a create moves the skill to the archive and logs it", async () => {
    write("deploy-staging", "learned v1");
    await appendLearnedChange(journal, { id: "c0ffee", at: 10, name: "deploy-staging", action: "create", reason: "new" });
    const result = await undoLearnedChange({ skillsDir, paths }, "c0ffee", 20);
    expect(result.outcome).toBe("removed");
    expect(existsSync(join(skillsDir, "deploy-staging"))).toBe(false);
    expect(readFileSync(join(paths.archiveDir, "deploy-staging", "SKILL.md"), "utf8")).toBe("learned v1");
    expect((await readSkillChanges(paths.changeLog)).at(-1)).toMatchObject({ name: "deploy-staging", action: "archive", actor: "user" });
    expect((await readLearnedChanges(journal))[0]?.undoneAt).toBe(20);
  });

  it("undoing a patch restores the version saved before it, and saves the patched copy", async () => {
    write("fix-build", "before the patch");
    const snapshot = await snapshotSkill({ skillsDir, historyDir: paths.historyDir }, "fix-build", 1_000);
    write("fix-build", "after the patch");
    await appendLearnedChange(journal, { id: "abc123", at: 1_001, name: "fix-build", action: "patch", snapshot: snapshot!, reason: "step 3 was wrong" });
    const result = await undoLearnedChange({ skillsDir, paths }, "abc123", 2_000);
    expect(result.outcome).toBe("restored");
    expect(read("fix-build")).toBe("before the patch");
    expect(result.savedAs).not.toBeNull();
    expect(readFileSync(join(paths.historyDir, "fix-build", result.savedAs!, "SKILL.md"), "utf8")).toBe("after the patch");
  });

  it("refuses an unknown id, a second undo, and an undo hidden behind a newer change", async () => {
    write("fix-build", "v0");
    const s1 = await snapshotSkill({ skillsDir, historyDir: paths.historyDir }, "fix-build", 1_000);
    write("fix-build", "v1");
    await appendLearnedChange(journal, { id: "111111", at: 1_001, name: "fix-build", action: "patch", snapshot: s1!, reason: "a" });
    const s2 = await snapshotSkill({ skillsDir, historyDir: paths.historyDir }, "fix-build", 1_002);
    write("fix-build", "v2");
    await appendLearnedChange(journal, { id: "222222", at: 1_003, name: "fix-build", action: "patch", snapshot: s2!, reason: "b" });

    await expect(undoLearnedChange({ skillsDir, paths }, "999999")).rejects.toBeInstanceOf(LearnUndoError);
    await expect(undoLearnedChange({ skillsDir, paths }, "111111")).rejects.toThrow(/undo 222222 first/);
    expect(read("fix-build")).toBe("v2");

    await undoLearnedChange({ skillsDir, paths }, "222222", 2_000);
    expect(read("fix-build")).toBe("v1");
    await expect(undoLearnedChange({ skillsDir, paths }, "222222")).rejects.toThrow(/already undone/);
    await undoLearnedChange({ skillsDir, paths }, "111111", 3_000);
    expect(read("fix-build")).toBe("v0");
  });

  it("/learn lists and undoes through the shared command", async () => {
    write("deploy-staging", "learned v1");
    await appendLearnedChange(journal, { id: "c0ffee", at: Date.UTC(2026, 10, 18, 9, 30), name: "deploy-staging", action: "create", reason: "deploy steps" });
    const listed = await runLearnCommand({ kind: "list" }, { stateDir: root, skillsDir });
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain("c0ffee  2026-11-18 09:30  new skill deploy-staging: deploy steps");
    const undone = await runLearnCommand({ kind: "undo", id: "c0ffee" }, { stateDir: root, skillsDir });
    expect(undone).toMatchObject({ ok: true, skillsChanged: true });
    expect(undone.text).toMatch(/removed the learned skill deploy-staging/);
    const again = await runLearnCommand({ kind: "undo", id: "c0ffee" }, { stateDir: root, skillsDir });
    expect(again).toMatchObject({ ok: false, skillsChanged: false });
    expect((await runLearnCommand({ kind: "list" }, { stateDir: root, skillsDir })).text).toContain("(undone)");
  });
});

describe("parseLearnCommand", () => {
  it("reads list and undo, rejects the rest", () => {
    expect(parseLearnCommand("")).toEqual({ kind: "list" });
    expect(parseLearnCommand(" list ")).toEqual({ kind: "list" });
    expect(parseLearnCommand("undo C0FFEE")).toEqual({ kind: "undo", id: "c0ffee" });
    expect(parseLearnCommand("undo").kind).toBe("error");
    expect(parseLearnCommand("undo ../x").kind).toBe("error");
    expect(parseLearnCommand("forget everything").kind).toBe("error");
  });
});
