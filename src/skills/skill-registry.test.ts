import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillRegistry, SkillNotFoundError } from "./skill-registry.js";

async function writeSkill(
  globalDir: string,
  name: string,
  description = `Skill ${name}`,
): Promise<void> {
  const dir = join(globalDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: "${description}"`,
      "version: 0.1.0",
      "---",
      "",
      `# ${name}`,
      "",
      `Body of ${name}.`,
    ].join("\n"),
    "utf8",
  );
}

describe("SkillRegistry disabled filtering", () => {
  let base: string;
  let global: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-skill-registry-"));
    global = join(base, "skills");
    await mkdir(global, { recursive: true });
    await writeSkill(global, "alpha");
    await writeSkill(global, "beta");
    await writeSkill(global, "gamma");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("default empty disabled set keeps all skills visible", async () => {
    const registry = new SkillRegistry({ globalDir: global, projectDir: null });
    await registry.refresh();
    expect(registry.list().map((s) => s.manifest.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(registry.has("alpha")).toBe(true);
    expect(registry.getDisabledNames()).toEqual([]);
  });

  it("disabled name is filtered out of list/has/get and surfaces as SkillNotFoundError", async () => {
    const registry = new SkillRegistry(
      { globalDir: global, projectDir: null },
      ["beta"],
    );
    await registry.refresh();
    expect(registry.list().map((s) => s.manifest.name)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(registry.has("beta")).toBe(false);
    expect(registry.isDisabled("beta")).toBe(true);
    expect(() => registry.get("beta")).toThrow(SkillNotFoundError);
  });

  it("listAll() exposes disabled records with their flag", async () => {
    const registry = new SkillRegistry(
      { globalDir: global, projectDir: null },
      ["beta"],
    );
    await registry.refresh();
    const all = registry.listAll();
    expect(all.map((e) => e.record.manifest.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(all.find((e) => e.record.manifest.name === "beta")?.disabled).toBe(
      true,
    );
    expect(all.find((e) => e.record.manifest.name === "alpha")?.disabled).toBe(
      false,
    );
  });

  it("setDisabledNames toggles the filter without re-scanning disk", async () => {
    const registry = new SkillRegistry({ globalDir: global, projectDir: null });
    await registry.refresh();
    expect(registry.has("alpha")).toBe(true);

    let changes = 0;
    registry.onChange(() => {
      changes += 1;
    });

    registry.setDisabledNames(["alpha"]);
    expect(registry.has("alpha")).toBe(false);
    expect(registry.list().map((s) => s.manifest.name)).toEqual([
      "beta",
      "gamma",
    ]);
    expect(changes).toBe(1);

    registry.setDisabledNames([]);
    expect(registry.has("alpha")).toBe(true);
    expect(changes).toBe(2);
  });

  it("setDisabledNames is a no-op when the set is unchanged", async () => {
    const registry = new SkillRegistry(
      { globalDir: global, projectDir: null },
      ["alpha"],
    );
    await registry.refresh();
    let changes = 0;
    registry.onChange(() => {
      changes += 1;
    });
    registry.setDisabledNames(["alpha"]);
    expect(changes).toBe(0);
  });

  it("disabling an uninstalled name is harmless", async () => {
    const registry = new SkillRegistry(
      { globalDir: global, projectDir: null },
      ["does-not-exist"],
    );
    await registry.refresh();
    expect(registry.list().map((s) => s.manifest.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(registry.isDisabled("does-not-exist")).toBe(true);
  });

  it("refresh keeps the current disabled filter applied", async () => {
    const registry = new SkillRegistry(
      { globalDir: global, projectDir: null },
      ["gamma"],
    );
    await registry.refresh();
    expect(registry.has("gamma")).toBe(false);

    await writeSkill(global, "delta");
    await registry.refresh();
    expect(registry.list().map((s) => s.manifest.name)).toEqual([
      "alpha",
      "beta",
      "delta",
    ]);
  });
});
