import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, uninstallSkill, SkillInstallError } from "./skill-installer.js";

async function writeSource(root: string, name = "demo"): Promise<string> {
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      'description: "demo skill"',
      "version: 0.1.0",
      "---",
      "body",
    ].join("\n"),
    "utf8",
  );
  return sourceDir;
}

describe("installSkill", () => {
  let base: string;
  let target: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-install-"));
    target = join(base, "target");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("copies a valid skill into the target dir", async () => {
    const source = await writeSource(base);
    const result = await installSkill({ sourceDir: source, targetRoot: target });
    expect(result.manifest.name).toBe("demo");
    const installed = await readFile(
      join(target, "demo", "SKILL.md"),
      "utf8",
    );
    expect(installed).toContain("name: demo");
  });

  it("refuses to overwrite without --force", async () => {
    const source = await writeSource(base);
    await installSkill({ sourceDir: source, targetRoot: target });
    await expect(
      installSkill({ sourceDir: source, targetRoot: target }),
    ).rejects.toMatchObject({ code: "already_installed" });
  });

  it("overwrites with force: true", async () => {
    const source = await writeSource(base);
    await installSkill({ sourceDir: source, targetRoot: target });
    await installSkill({ sourceDir: source, targetRoot: target, force: true });
    expect(true).toBe(true);
  });

  it("rejects missing SKILL.md", async () => {
    const emptyDir = join(base, "empty");
    await mkdir(emptyDir, { recursive: true });
    await expect(
      installSkill({ sourceDir: emptyDir, targetRoot: target }),
    ).rejects.toBeInstanceOf(SkillInstallError);
  });

  it("uninstallSkill removes installed skill", async () => {
    const source = await writeSource(base);
    const installed = await installSkill({
      sourceDir: source,
      targetRoot: target,
    });
    const outcome = await uninstallSkill(target, installed.manifest.name);
    expect(outcome.removed).toBe(true);
  });
});
