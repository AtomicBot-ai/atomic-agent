import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergePolicySources } from "../policy/policy-loader.js";
import { skillPolicyRefusal } from "../policy/policy-enforce.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import { EMPTY_POLICY } from "../policy/policy-evaluator.js";
import { installSkill, SkillInstallError } from "./skill-installer.js";
import { SkillRegistry } from "./skill-registry.js";

const policy = mergePolicySources([{
  status: { kind: "system", location: "test", state: "loaded" },
  file: parsePolicyFile({ rules: [{ action: "skill", resource: "publish-*", effect: "deny" }] }),
}]);

async function writeSkill(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: "Skill ${name}"`, "version: 0.1.0", "---", "", `Body of ${name}.`].join("\n"),
    "utf8",
  );
  return dir;
}

describe("organization policy for skills (ATO-587)", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-skill-policy-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("install refuses a skill the policy denies and writes nothing", async () => {
    const source = await writeSkill(join(base, "src"), "publish-site");
    const target = join(base, "skills");
    const err = await installSkill({ sourceDir: source, targetRoot: target, policy }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillInstallError);
    expect((err as SkillInstallError).code).toBe("policy_denied");
    expect((err as Error).message).toContain('skill "publish-site" is blocked');
    expect(await stat(join(target, "publish-site")).catch(() => null)).toBeNull();
  });

  it("install goes ahead for a skill the policy does not name", async () => {
    const source = await writeSkill(join(base, "src"), "notes");
    const result = await installSkill({ sourceDir: source, targetRoot: join(base, "skills"), policy });
    expect(result.manifest.name).toBe("notes");
  });

  it("install with an empty policy behaves as before", async () => {
    const source = await writeSkill(join(base, "src"), "publish-site");
    const result = await installSkill({ sourceDir: source, targetRoot: join(base, "skills"), policy: EMPTY_POLICY });
    expect(result.manifest.name).toBe("publish-site");
  });

  it("the registry does not load a denied skill and marks it in listAll", async () => {
    const global = join(base, "skills");
    await writeSkill(global, "publish-site");
    await writeSkill(global, "notes");
    const registry = new SkillRegistry(
      { globalDir: global, projectDir: null },
      [],
      undefined,
      (name) => skillPolicyRefusal(policy, name) !== null,
    );
    await registry.refresh();
    expect(registry.list().map((s) => s.manifest.name)).toEqual(["notes"]);
    expect(registry.has("publish-site")).toBe(false);
    expect(registry.listAll().find((e) => e.record.manifest.name === "publish-site")?.blocked).toBe(true);
    expect(registry.listAll().find((e) => e.record.manifest.name === "notes")?.blocked).toBeUndefined();
  });
});
