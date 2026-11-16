import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `monid` starter connects the agent to Monid's paid data tools
 * through `curl` and `MONID_API_KEY`. These cases pin what keeps it
 * working and safe: the key reaches the shell by default, every call goes
 * through the shell (the HTTP tool cannot expand the variable), the price
 * is stated before a billed run, and results are never invented.
 */
describe("the monid starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "monid", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("monid");
    const { manifest } = parseSkillFile(body);
    expect(manifest.name).toBe("monid");
    expect(manifest.requiresTools).toContain("os.shell.run");
  });

  it("gets MONID_API_KEY in the shell by default", () => {
    expect(USER_CONFIG_DEFAULTS.tools.shell.envPassthrough).toContain(
      "MONID_API_KEY",
    );
  });

  it("calls Monid through the shell, never the HTTP tool", () => {
    expect(body).toMatch(/Do not use `os\.http\.request`/);
    expect(body).toMatch(/\$MONID_API_KEY/);
  });

  it("states the price before a billed run and never invents results", () => {
    expect(body).toMatch(/price before running/);
    expect(body).toMatch(/Never invent results/);
    expect(body).toMatch(/Report only data that is in the run's `output`/);
  });

  it("never asks for the key in chat", () => {
    expect(body).toMatch(/Do not ask them to paste the key into the chat/);
  });
});
