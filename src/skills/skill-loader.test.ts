import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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

  it("project skill shadows global of same name", async () => {
    await writeSkill(global, "shared", "global version", "0.1.0");
    await writeSkill(project, "shared", "project override", "0.2.0");
    const result = await loadSkills({ globalDir: global, projectDir: project });
    expect(result.skills).toHaveLength(1);
    const winner = result.skills[0]!;
    expect(winner.manifest.version).toBe("0.2.0");
    expect(winner.source).toBe("project");
  });

  it("collects errors for broken SKILL.md", async () => {
    await mkdir(join(global, "broken"), { recursive: true });
    await writeFile(join(global, "broken", "SKILL.md"), "no frontmatter", "utf8");
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
});
