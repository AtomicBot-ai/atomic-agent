import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `pre-push-check` starter (ATO-1161): before pushing code the agent
 * wrote, it asks the user three questions about it. These cases pin the
 * trigger, the three question kinds, and the escape hatches that keep it
 * from ever blocking a push.
 */
describe("the pre-push-check starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "pre-push-check", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("pre-push-check");
    expect(parseSkillFile(body).manifest.name).toBe("pre-push-check");
  });

  it("is selected right before a push of the agent's own code", () => {
    expect(body).toMatch(/description:.*os\.git\.push/);
    expect(body).toMatch(/description:.*three short questions/);
  });

  it("asks one question of each kind", () => {
    expect(body).toMatch(/\*\*What changed\*\*/);
    expect(body).toMatch(/\*\*What could break\*\*/);
    expect(body).toMatch(/\*\*How to check it\*\*/);
    expect(body).toMatch(/Exactly three questions/);
  });

  it("can be skipped and turned off, and never blocks a push", () => {
    expect(body).toMatch(/just push/);
    expect(body).toMatch(/\/skill disable pre-push-check/);
    expect(body).toMatch(/never blocks a push/);
  });
});
