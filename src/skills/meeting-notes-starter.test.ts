import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `meeting-notes` starter (ATO-1075) turns a meeting transcript into
 * minutes. These cases pin the parts an agent and a reader key off: the
 * fixed sections, the no-invention rule, where the file goes, and that
 * reminders are only scheduled after a yes.
 */
describe("the meeting-notes starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "meeting-notes", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("meeting-notes");
    const { manifest } = parseSkillFile(body);
    expect(manifest.name).toBe("meeting-notes");
    expect(manifest.description).toMatch(/minutes/);
  });

  it("keeps the same sections in every set of minutes", () => {
    for (const heading of ["## Summary", "## Decisions", "## Action items", "## Open questions"]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain("| # | Task | Owner | Due |");
  });

  it("writes only what was said", () => {
    expect(body).toMatch(/\*\*Only what was said\.\*\*/);
    expect(body).toMatch(/`unassigned` \/ `not set`/);
  });

  it("hands recordings to audio-transcribe and saves next to the source", () => {
    expect(body).toMatch(/load the `audio-transcribe` skill/);
    expect(body).toMatch(/<source name without extension>\.notes\.md/);
  });

  it("schedules reminders only after a yes", () => {
    expect(body).toMatch(/Never schedule without a yes/);
    expect(body).toMatch(/`tasks\.schedule`/);
  });
});
