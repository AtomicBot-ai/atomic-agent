import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `plain-writing` starter (ATO-1160) strips machine-text tells from
 * copy without changing its meaning. These cases pin the rules an agent
 * keys off, so an edit cannot drop the meaning-preservation rule or the
 * dash check.
 */
describe("the plain-writing starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "plain-writing", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("plain-writing");
    expect(parseSkillFile(body).manifest.name).toBe("plain-writing");
  });

  it("is selected for public text and landing pages", () => {
    expect(body).toMatch(/description:.*landing page/);
    expect(body).toMatch(/description:.*AI slop/);
  });

  it("keeps meaning and forbids invented facts", () => {
    expect(body).toMatch(/Change how it is said, never what is said/);
    expect(body).toMatch(/never write new ones/);
  });

  it("checks the output for long dashes before answering", () => {
    expect(body).toMatch(/Search your output for `—` and `–`/);
  });

  it("covers page layout, not only prose", () => {
    expect(body).toMatch(/## Landing pages and layout/);
  });
});
