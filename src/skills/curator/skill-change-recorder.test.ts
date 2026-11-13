import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillChanges } from "./skill-change-log.js";
import { skillCuratorPaths } from "./skill-curator-config.js";
import { listSkillVersions } from "./skill-history.js";
import { SkillChangeRecorder } from "./skill-change-recorder.js";

describe("SkillChangeRecorder", () => {
  let root: string;
  let skillsDir: string;
  let recorder: SkillChangeRecorder;
  let clock: number;

  const write = (name: string, body: string) => {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, "SKILL.md"), body, "utf8");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-skill-recorder-"));
    skillsDir = join(root, "skills");
    clock = 1_000;
    recorder = new SkillChangeRecorder(skillsDir, skillCuratorPaths(root), () => clock++);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("logs a create by the agent and marks the skill agent-learned", async () => {
    const before = await recorder.before("learned");
    expect(before).toEqual({ name: "learned", existed: false, snapshot: null });
    write("learned", "v1");
    await recorder.after(before, "agent", "os.fs.write");
    const [entry] = await readSkillChanges(skillCuratorPaths(root).changeLog);
    expect(entry).toMatchObject({ name: "learned", action: "create", actor: "agent", tool: "os.fs.write" });
    expect((await recorder.ledger.get("learned"))?.origin).toBe("agent");
  });

  it("snapshots before an edit and logs it with the snapshot id", async () => {
    write("learned", "v1");
    const before = await recorder.before("learned");
    expect(before.snapshot).not.toBeNull();
    write("learned", "v2");
    await recorder.after(before, "agent", "os.fs.edit");
    const changes = await readSkillChanges(skillCuratorPaths(root).changeLog, "learned");
    expect(changes).toEqual([
      expect.objectContaining({ action: "edit", actor: "agent", snapshot: before.snapshot }),
    ]);
    expect(await listSkillVersions(skillCuratorPaths(root).historyDir, "learned")).toEqual([before.snapshot]);
    // An edit of an existing folder does not claim the agent wrote it.
    expect((await recorder.ledger.get("learned"))?.origin).toBeUndefined();
  });

  it("logs a delete, and a user create does not count as agent-learned", async () => {
    write("gone", "x");
    const before = await recorder.before("gone");
    rmSync(join(skillsDir, "gone"), { recursive: true });
    await recorder.after(before, "agent", "os.fs.trash");
    const userBefore = await recorder.before("mine");
    write("mine", "y");
    await recorder.after(userBefore, "user");
    const changes = await readSkillChanges(skillCuratorPaths(root).changeLog);
    expect(changes.map((e) => [e.name, e.action, e.actor])).toEqual([
      ["gone", "delete", "agent"],
      ["mine", "create", "user"],
    ]);
    expect(await recorder.ledger.get("mine")).toBeUndefined();
  });

  it("logs nothing when the folder neither existed nor appeared", async () => {
    const before = await recorder.before("nothing");
    await recorder.after(before, "agent");
    expect(await readSkillChanges(skillCuratorPaths(root).changeLog)).toEqual([]);
  });

  it("reads past a corrupt line in the change log", async () => {
    const before = await recorder.before("a");
    write("a", "1");
    await recorder.after(before, "agent");
    appendFileSync(skillCuratorPaths(root).changeLog, "garbage\n{\"at\":1}\n", "utf8");
    expect(await readSkillChanges(skillCuratorPaths(root).changeLog)).toHaveLength(1);
  });

  it("counts uses only for plain folder names", async () => {
    await recorder.recordUse("alpha");
    await recorder.recordUse("../escape");
    expect((await recorder.ledger.read()).skills).toEqual({ alpha: { useCount: 1, lastUsedAt: expect.any(Number) } });
  });
});
