import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillCommand } from "./skill.js";
import { resetConfigCache } from "../config/index.js";
import { DAY_MS, readSkillChanges, SkillUsageLedger, skillCuratorPaths } from "../skills/curator/index.js";
import { appendLearnedChange, learnedJournalFile, savePendingDraft } from "../skills/learning/index.js";

function writeSkill(globalDir: string, name: string, body = `Body of ${name}.`): void {
  const dir = join(globalDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: "Skill ${name}"`, "version: 0.1.0", "---", "", body].join("\n"),
    "utf8",
  );
}

describe("skill history / restore / curate", () => {
  let stateDir: string;
  let globalSkillsDir: string;
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-skill-history-"));
    globalSkillsDir = join(stateDir, "skills");
    mkdirSync(globalSkillsDir, { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("uninstall saves a version that restore puts back", async () => {
    writeSkill(globalSkillsDir, "alpha", "original body");
    expect(await skillCommand(["uninstall", "alpha"])).toBe(0);
    expect(existsSync(join(globalSkillsDir, "alpha"))).toBe(false);

    stdout = "";
    expect(await skillCommand(["history", "alpha"])).toBe(0);
    expect(stdout).toMatch(/alpha\tdelete\tuser/);
    expect(stdout).toMatch(/versions: \d{8}T\d{9}Z/);

    expect(await skillCommand(["restore", "alpha"])).toBe(0);
    expect(readFileSync(join(globalSkillsDir, "alpha", "SKILL.md"), "utf8")).toContain("original body");
    const log = await readSkillChanges(skillCuratorPaths(stateDir).changeLog, "alpha");
    expect(log.map((e) => [e.action, e.actor])).toEqual([
      ["delete", "user"],
      ["restore", "user"],
    ]);
  });

  it("restore --version picks a named version", async () => {
    writeSkill(globalSkillsDir, "beta", "first");
    await skillCommand(["uninstall", "beta"]);
    const [version] = (await readSkillChanges(skillCuratorPaths(stateDir).changeLog, "beta")).map((e) => e.snapshot);
    writeSkill(globalSkillsDir, "beta", "second");
    expect(await skillCommand(["restore", "beta", "--version", version!])).toBe(0);
    expect(readFileSync(join(globalSkillsDir, "beta", "SKILL.md"), "utf8")).toContain("first");
  });

  it("restore with nothing saved fails with a clear message", async () => {
    expect(await skillCommand(["restore", "ghost"])).toBe(1);
    expect(stderr).toContain("no saved versions of skill: ghost");
    expect(await skillCommand(["restore"])).toBe(2);
  });

  it("curate archives only agent-learned skills, and restore undoes it", async () => {
    writeSkill(globalSkillsDir, "learned-old");
    writeSkill(globalSkillsDir, "my-own");
    await new SkillUsageLedger(skillCuratorPaths(stateDir).usageFile).markAgentCreated("learned-old", Date.now() - 40 * DAY_MS);

    stdout = "";
    expect(await skillCommand(["curate", "--dry-run"])).toBe(0);
    expect(stdout).toMatch(/would archive\tlearned-old/);
    expect(existsSync(join(globalSkillsDir, "learned-old"))).toBe(true);

    expect(await skillCommand(["curate"])).toBe(0);
    expect(existsSync(join(globalSkillsDir, "learned-old"))).toBe(false);
    expect(existsSync(join(globalSkillsDir, "my-own"))).toBe(true);
    expect(existsSync(join(skillCuratorPaths(stateDir).archiveDir, "learned-old", "SKILL.md"))).toBe(true);

    expect(await skillCommand(["restore", "learned-old"])).toBe(0);
    expect(stdout).toContain("restored learned-old from archive");
    expect(existsSync(join(globalSkillsDir, "learned-old", "SKILL.md"))).toBe(true);
  });
  it("skill learned lists what self-learning saved and undo takes it back (ATO-67)", async () => {
    stdout = "";
    expect(await skillCommand(["learned"])).toBe(0);
    expect(stdout).toMatch(/Nothing learned yet/);

    writeSkill(globalSkillsDir, "sync-with-delete");
    await appendLearnedChange(learnedJournalFile(skillCuratorPaths(stateDir)), {
      id: "c0ffee", at: Date.now(), name: "sync-with-delete", action: "create", reason: "stale files stayed",
    });
    stdout = "";
    expect(await skillCommand(["learned"])).toBe(0);
    expect(stdout).toMatch(/c0ffee .* new skill sync-with-delete: stale files stayed/);
    expect(stdout).toContain("atomic-agent skill learned undo <id>");

    expect(await skillCommand(["learned", "undo", "c0ffee"])).toBe(0);
    expect(existsSync(join(globalSkillsDir, "sync-with-delete"))).toBe(false);
    expect(await skillCommand(["learned", "undo", "c0ffee"])).toBe(1);
    expect(stderr).toMatch(/already undone/);
    expect(await skillCommand(["learned", "forget"])).toBe(2);
  });

  it("skill learned lists pending drafts, approve and discard them; skill list --json marks them pending (ATO-67)", async () => {
    const content = "---\nname: changelog-notes\ndescription: Collect release notes from the changelog.\nversion: 1.0.0\n---\n\n1. Open CHANGELOG.md.\n2. Copy the newest section.\n";
    const draft = await savePendingDraft(stateDir, { kind: "create", name: "changelog-notes", reason: "changelog steps", content, sources: ["os.web.fetch"], origin: "discord" });
    const other = await savePendingDraft(stateDir, { kind: "create", name: "other-notes", reason: "other", content: content.replaceAll("changelog-notes", "other-notes"), sources: [] });

    stdout = "";
    expect(await skillCommand(["learned"])).toBe(0);
    expect(stdout).toContain(`${draft.id}`);
    expect(stdout).toContain("(Pending review)");
    expect(stdout).toContain("atomic-agent skill learned approve <id>");

    stdout = "";
    expect(await skillCommand(["list", "--json"])).toBe(0);
    const rows = JSON.parse(stdout) as Array<{ name: string; status: string; draftId?: string }>;
    expect(rows.filter((r) => r.status === "pending").map((r) => r.draftId).sort()).toEqual([draft.id, other.id].sort());
    stdout = "";
    expect(await skillCommand(["list"])).toBe(0);
    expect(stdout).not.toContain("changelog-notes");

    expect(await skillCommand(["learned", "approve", draft.id])).toBe(0);
    expect(readFileSync(join(globalSkillsDir, "changelog-notes", "SKILL.md"), "utf8")).toBe(content);
    expect(await skillCommand(["learned", "discard", other.id])).toBe(0);
    expect(existsSync(join(globalSkillsDir, "other-notes"))).toBe(false);
    expect(await skillCommand(["learned", "discard", other.id])).toBe(1);
  });
});
