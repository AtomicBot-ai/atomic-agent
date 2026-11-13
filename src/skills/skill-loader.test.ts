import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "./skill-loader.js";

async function writeSkill(
  root: string,
  name: string,
  description: string,
  version = "0.1.0",
  platforms?: string[],
): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: "${description}"`,
    `version: ${version}`,
  ];
  if (platforms) lines.push(`platforms: [${platforms.join(", ")}]`);
  lines.push("---", "body");
  await writeFile(join(root, name, "SKILL.md"), lines.join("\n"), "utf8");
}

describe("loadSkills", () => {
  let base: string;
  let global: string;
  let project: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-skills-"));
    global = join(base, "global");
    project = join(base, "project");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("returns empty list when directories do not exist", async () => {
    const result = await loadSkills({ globalDir: global, projectDir: project });
    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("loads skills from global dir", async () => {
    await writeSkill(global, "alpha", "Alpha skill");
    const result = await loadSkills({ globalDir: global, projectDir: null });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.manifest.name).toBe("alpha");
    expect(result.skills[0]!.source).toBe("global");
  });

  it("global skill wins over a project skill of the same name and reports the project copy", async () => {
    await writeSkill(global, "shared", "global version", "0.1.0");
    await writeSkill(project, "shared", "project override", "0.2.0");
    const result = await loadSkills({ globalDir: global, projectDir: project });
    expect(result.skills).toHaveLength(1);
    const winner = result.skills[0]!;
    expect(winner.manifest.version).toBe("0.1.0");
    expect(winner.source).toBe("global");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toBe(join(project, "shared"));
    expect(result.errors[0]!.error).toContain("the project copy is ignored");
  });

  it("loads a project skill whose name no global skill uses", async () => {
    await writeSkill(global, "alpha", "global alpha");
    await writeSkill(project, "beta", "project beta");
    const result = await loadSkills({ globalDir: global, projectDir: project });
    expect(result.skills.map((s) => [s.manifest.name, s.source])).toEqual([
      ["alpha", "global"],
      ["beta", "project"],
    ]);
    expect(result.errors).toEqual([]);
  });

  it("keeps source 'global' when projectDir resolves to the same path as globalDir", async () => {
    // A relative `ATOMIC_AGENT_STATE_DIR=.atomic-agent` run from the repo
    // root collapses globalDir and projectDir onto the same absolute path.
    // The project scan must be skipped so the skill is not relabelled
    // "project" (which would block global-only uninstall).
    await writeSkill(global, "alpha", "Alpha skill");
    const sameButUnnormalised = join(global, ".", "..", "global");
    const result = await loadSkills({
      globalDir: global,
      projectDir: sameButUnnormalised,
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.manifest.name).toBe("alpha");
    expect(result.skills[0]!.source).toBe("global");
  });

  it("collects errors for broken SKILL.md", async () => {
    await mkdir(join(global, "broken"), { recursive: true });
    await writeFile(
      join(global, "broken", "SKILL.md"),
      "no frontmatter",
      "utf8",
    );
    const result = await loadSkills({ globalDir: global, projectDir: null });
    expect(result.skills).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toContain("broken");
  });

  it("excludes a skill whose platforms allowlist omits the current OS", async () => {
    await writeSkill(global, "mac-only", "darwin skill", "0.1.0", ["darwin"]);
    await writeSkill(global, "everywhere", "cross-platform", "0.1.0");
    const result = await loadSkills({
      globalDir: global,
      projectDir: null,
      platform: "linux",
    });
    expect(result.skills.map((s) => s.manifest.name)).toEqual(["everywhere"]);
  });

  it("includes a platform-gated skill on a matching OS", async () => {
    await writeSkill(global, "mac-only", "darwin skill", "0.1.0", ["darwin"]);
    const result = await loadSkills({
      globalDir: global,
      projectDir: null,
      platform: "darwin",
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.manifest.name).toBe("mac-only");
  });

  it("loads plugin skills as plugin:skill and keeps an installed skill's name", async () => {
    await writeSkill(global, "demo", "user skill named like the plugin");
    const pluginRoot = join(base, "plugin");
    await writeSkill(join(pluginRoot, "skills"), "review", "plugin review");
    await writeFile(join(pluginRoot, "SKILL.md"), "---\nname: demo\ndescription: root skill\n---\n", "utf8");
    const res = await loadSkills({
      globalDir: global,
      projectDir: null,
      pluginSkills: () => [
        { plugin: "demo", dir: join(pluginRoot, "skills", "review"), rootSkill: false },
        { plugin: "demo", dir: pluginRoot, rootSkill: true },
      ],
    });
    const byName = Object.fromEntries(res.skills.map(s => [s.manifest.name, s]));
    expect(byName["demo:review"]).toMatchObject({ source: "global", plugin: "demo" });
    expect(byName["demo"]!.plugin).toBeUndefined();
    expect(res.errors.some(e => e.error.includes("plugin copy is ignored"))).toBe(true);
  });
  describe("shared ~/.agents/skills folder (ATO-706)", () => {
    let home: string;
    let shared: string;
    beforeEach(async () => {
      base = await realpath(base);
      global = join(base, "global"); project = join(base, "project");
      home = join(base, "home"); shared = join(home, ".agents", "skills");
    });

    it("loads skills installed for all agents as user-level shared skills", async () => {
      await writeSkill(shared, "everywhere", "shared skill");
      const res = await loadSkills({ globalDir: global, projectDir: project, homeDir: home });
      expect(res.skills).toHaveLength(1);
      expect(res.skills[0]).toMatchObject({ source: "global", shared: true, rootDir: join(shared, "everywhere") });
      expect(res.errors).toEqual([]);
    });

    it("lets global, plugin and project copies win over the shared copy", async () => {
      for (const name of ["g", "p", "demo"]) await writeSkill(shared, name, "shared");
      await writeSkill(global, "g", "global"); await writeSkill(project, "p", "project");
      const pluginDir = join(base, "plugin");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "SKILL.md"), "---\nname: demo\ndescription: plugin\n---\n", "utf8");
      const res = await loadSkills({ globalDir: global, projectDir: project, homeDir: home,
        pluginSkills: () => [{ plugin: "demo", dir: pluginDir, rootSkill: true }] });
      const byName = Object.fromEntries(res.skills.map(s => [s.manifest.name, s]));
      expect(byName["g"]!.manifest.description).toBe("global");
      expect(byName["p"]!.source).toBe("project");
      expect(byName["demo"]!.plugin).toBe("demo");
      expect(res.skills.some(s => s.shared)).toBe(false);
      expect(res.errors.filter(e => e.error.includes("the shared copy is ignored"))).toHaveLength(3);
    });

    it("follows a symlinked skill folder but refuses a SKILL.md that resolves outside it", async () => {
      await writeSkill(join(base, "store"), "linked", "linked");
      await mkdir(shared, { recursive: true });
      await symlink(join(base, "store", "linked"), join(shared, "linked"));
      await writeSkill(join(base, "outside"), "escape", "outside");
      await mkdir(join(shared, "escape"), { recursive: true });
      await symlink(join(base, "outside", "escape", "SKILL.md"), join(shared, "escape", "SKILL.md"));
      const res = await loadSkills({ globalDir: global, projectDir: null, homeDir: home });
      expect(res.skills.map(s => s.manifest.name)).toEqual(["linked"]);
      expect(res.skills[0]!.rootDir).toBe(join(base, "store", "linked"));
      expect(res.errors.some(e => e.error.includes("resolves outside its folder"))).toBe(true);
    });

    it("reads the env override when no home folder is given, and null turns it off", async () => {
      await writeSkill(shared, "via-env", "shared");
      const prev = process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR;
      process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR = shared;
      try {
        expect((await loadSkills({ globalDir: global, projectDir: null })).skills.map(s => s.manifest.name)).toEqual(["via-env"]);
        expect((await loadSkills({ globalDir: global, projectDir: null, homeDir: null })).skills).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR; else process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR = prev;
      }
    });

    it("keeps the global classification when the shared folder is the global folder", async () => {
      await writeSkill(shared, "same", "both");
      const res = await loadSkills({ globalDir: shared, projectDir: null, homeDir: home });
      expect(res.skills[0]!.shared).toBeUndefined();
    });
  });
});
