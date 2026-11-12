import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "../tool-registry.js";
import { readSkillChanges, SkillChangeRecorder, skillCuratorPaths, listSkillVersions } from "../../skills/curator/index.js";
import { skillNameForPath, skillTargets, trackSkillEdits } from "./skill-edit-tracker.js";

describe.skipIf(process.platform === "win32")("skillTargets", () => {
  const skills = "/state/skills";

  it("finds the skill folder a path argument falls in", () => {
    expect(skillTargets("os.fs.write", { path: "/state/skills/learned/SKILL.md" }, "/work", skills)).toEqual(["learned"]);
    expect(skillTargets("os.fs.edit", { path: "../state/skills/x/a.md" }, "/work", skills)).toEqual(["x"]);
    expect(skillTargets("os.fs.write", { path: "/work/notes.md" }, "/work", skills)).toEqual([]);
  });

  it("reads move pairs, trash lists and patch headers", () => {
    expect(skillTargets("os.fs.move", { from: "/state/skills/a", to: "/state/skills/b" }, "/w", skills)).toEqual(["a", "b"]);
    expect(skillTargets("os.fs.move", { moves: [{ from: "/tmp/x", to: "/state/skills/c/x" }] }, "/w", skills)).toEqual(["c"]);
    expect(skillTargets("os.fs.trash", { paths: ["/state/skills/d", "/elsewhere"] }, "/w", skills)).toEqual(["d"]);
    const patch = "--- a/e/SKILL.md\n+++ b/e/SKILL.md\n@@ -1 +1 @@\n-x\n+y\n";
    expect(skillTargets("os.fs.patch", { patch, rootDir: "/state/skills" }, "/w", skills)).toEqual(["e"]);
  });

  it("ignores the skills folder itself and other tools", () => {
    expect(skillNameForPath(skills, "/state/skills")).toBeNull();
    expect(skillNameForPath(skills, "/state/skills-history/a")).toBeNull();
    expect(skillTargets("os.fs.read", { path: "/state/skills/a/SKILL.md" }, "/w", skills)).toEqual([]);
  });
});

describe("trackSkillEdits", () => {
  let root: string;
  let skillsDir: string;
  let registry: ToolRegistry;
  let recorder: SkillChangeRecorder;

  const ctx = (): ToolContext => ({ workingDir: root, sessionId: "s1" }) as unknown as ToolContext;
  const fakeWrite = (fail = false): ToolDefinition => ({
    name: "os.fs.write",
    description: "write",
    readonly: false,
    async run(args) {
      const path = String(args.path);
      if (fail) return { tool: "os.fs.write", status: "error", summary: "nope" } as never;
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, String(args.content), "utf8");
      return { tool: "os.fs.write", status: "ok", summary: "written" } as never;
    },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-skill-tracker-"));
    skillsDir = join(root, "skills");
    registry = new ToolRegistry();
    recorder = new SkillChangeRecorder(skillsDir, skillCuratorPaths(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps the tool's metadata and wraps it once", () => {
    const inner = fakeWrite();
    registry.register(inner);
    expect(trackSkillEdits(registry, { recorder })).toEqual(["os.fs.write"]);
    const wrapped = registry.get("os.fs.write");
    expect({ ...wrapped, run: inner.run }).toEqual(inner);
    trackSkillEdits(registry, { recorder });
    expect(registry.get("os.fs.write")).toBe(wrapped);
  });

  it("logs a create, then snapshots and logs an edit", async () => {
    registry.register(fakeWrite());
    trackSkillEdits(registry, { recorder });
    const file = join(skillsDir, "learned", "SKILL.md");
    await registry.get("os.fs.write").run({ path: file, content: "v1" }, ctx());
    await registry.get("os.fs.write").run({ path: file, content: "v2" }, ctx());
    const changes = await readSkillChanges(skillCuratorPaths(root).changeLog, "learned");
    expect(changes.map((e) => [e.action, e.actor, e.tool])).toEqual([
      ["create", "agent", "os.fs.write"],
      ["edit", "agent", "os.fs.write"],
    ]);
    expect(await listSkillVersions(skillCuratorPaths(root).historyDir, "learned")).toHaveLength(1);
    expect((await recorder.ledger.get("learned"))?.origin).toBe("agent");
  });

  it("does not mark a skill the agent only moved into place as agent-learned", async () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "SKILL.md"), "mine", "utf8");
    registry.register({
      name: "os.fs.move",
      description: "move",
      readonly: false,
      async run(args) {
        mkdirSync(skillsDir, { recursive: true });
        renameSync(String(args.from), String(args.to));
        return { tool: "os.fs.move", status: "ok", summary: "moved" } as never;
      },
    });
    trackSkillEdits(registry, { recorder });
    await registry.get("os.fs.move").run({ from: join(root, "elsewhere"), to: join(skillsDir, "moved") }, ctx());
    const [entry] = await readSkillChanges(skillCuratorPaths(root).changeLog, "moved");
    expect(entry).toMatchObject({ action: "create", actor: "agent", tool: "os.fs.move" });
    expect(await recorder.ledger.get("moved")).toBeUndefined();
  });

  it("logs nothing for a failed call or a file outside the skills folder", async () => {
    registry.register(fakeWrite(true));
    trackSkillEdits(registry, { recorder });
    await registry.get("os.fs.write").run({ path: join(skillsDir, "x", "SKILL.md"), content: "v" }, ctx());
    expect(await readSkillChanges(skillCuratorPaths(root).changeLog)).toEqual([]);
    registry.register(fakeWrite());
    trackSkillEdits(registry, { recorder });
    await registry.get("os.fs.write").run({ path: join(root, "notes.md"), content: "v" }, ctx());
    expect(existsSync(skillCuratorPaths(root).changeLog)).toBe(false);
  });

  it("never fails the tool call when bookkeeping breaks", async () => {
    registry.register(fakeWrite());
    const errors: unknown[] = [];
    const broken = new SkillChangeRecorder(skillsDir, { ...skillCuratorPaths(root), changeLog: join(root, "missing-parent", "\0bad") });
    trackSkillEdits(registry, { recorder: broken, onError: (err) => errors.push(err) });
    const result = await registry.get("os.fs.write").run({ path: join(skillsDir, "y", "SKILL.md"), content: "v" }, ctx());
    expect(result.status).toBe("ok");
    expect(errors.length).toBeGreaterThan(0);
  });
});
