import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `audit` starter (ATO-1159) exists so a security review reports only
 * findings that survived an attempt to refute them. These cases pin the
 * parts that make it that, so a later edit cannot turn it back into a
 * single pass that lists every suspicion.
 */
describe("the audit starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "audit", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("audit");
    const parsed = parseSkillFile(body);
    expect(parsed.manifest.name).toBe("audit");
    expect(parsed.manifest.dangerous).toBe(false);
  });

  it("is named so the slash command is /audit", () => {
    expect(body).toContain("name: audit\n");
    expect(body).toMatch(/description:.*\/audit/);
  });

  it("has a find pass and a refute pass", () => {
    expect(body).toMatch(/## Pass 1: find candidates/);
    expect(body).toMatch(/## Pass 2: try to refute every candidate/);
    expect(body).toMatch(/fusion\.delegate/);
  });

  it("reports only confirmed findings", () => {
    expect(body).toMatch(/Only CONFIRMED findings go into the report/);
    expect(body).toMatch(/Dropped: N refuted, M unsure/);
  });

  it("stays read-only and does not leak secrets", () => {
    expect(body).toMatch(/read-only/);
    expect(body).toMatch(/Never print a secret you found in full/);
  });
});
