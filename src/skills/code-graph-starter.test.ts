import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `code-graph` starter (ATO-1015) answers "who calls X" and "where is
 * Y" from `os.fs.code_map` plus targeted searches. These cases pin that it
 * starts from the map, cites every edge, and states the limits of a
 * search-based graph.
 */
describe("the code-graph starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "code-graph", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("code-graph");
    const parsed = parseSkillFile(body);
    expect(parsed.manifest.name).toBe("code-graph");
    expect(parsed.manifest.requiresTools).toContain("os.fs.code_map");
  });

  it("is selected for wiring questions", () => {
    expect(body).toMatch(/description:.*who calls/);
    expect(body).toMatch(/description:.*payments/);
  });

  it("covers callers, dependencies, features and paths", () => {
    expect(body).toMatch(/\*\*Who calls X\?\*\*/);
    expect(body).toMatch(/\*\*What does X call \/ depend on\?\*\*/);
    expect(body).toMatch(/\*\*Where is feature Y\?\*\*/);
    expect(body).toMatch(/\*\*How does A reach B\?\*\*/);
  });

  it("cites edges and refuses to invent them", () => {
    expect(body).toMatch(/path:line/);
    expect(body).toMatch(/Never invent an edge/);
    expect(body).toMatch(/search-based graph/);
  });
});
