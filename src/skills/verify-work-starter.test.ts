import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `verify-work` starter exists to stop a turn reporting unrun code as
 * done. These cases pin the parts an agent actually keys off — the
 * frontmatter it is selected by, and the instructions that make the check
 * concrete — so a later edit cannot quietly soften it into advice.
 */
describe("the verify-work starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "verify-work", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack", async () => {
    expect(await listStarterSkillNames()).toContain("verify-work");
  });

  it("is selected when work is about to be reported as done", () => {
    expect(body).toContain("name: verify-work");
    expect(body).toMatch(/description:.*(done|working|fixed)/);
  });

  it("declares the tools the checks need", () => {
    expect(body).toContain("os.shell.run");
  });

  it("states the rule as a prohibition, not a suggestion", () => {
    expect(body).toMatch(/Never report code as working, done, or fixed/);
    expect(body).toMatch(/"Should work" is not a verdict/);
  });

  it("tells the agent to read the project's own runner before guessing one", () => {
    expect(body).toMatch(/package\.json/);
    expect(body).toMatch(/do not guess a runner/);
  });

  it("covers the visual case, where a loading page can still be broken", () => {
    expect(body).toMatch(/console/i);
    expect(body).toMatch(/screenshot/i);
    expect(body).toMatch(/blank/i);
  });

  it("bounds the retry loop and forbids weakening the check to pass it", () => {
    expect(body).toMatch(/three/i);
    expect(body).toMatch(/[Nn]ever delete or weaken a test/);
  });

  it("requires an honest answer when a check cannot run", () => {
    expect(body).toMatch(/could not run/);
  });
});
