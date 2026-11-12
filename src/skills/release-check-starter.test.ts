import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `release-check` starter (ATO-219, GH #115): a separate pass before a
 * release that does not trust the implementing model's own green tests.
 * These cases pin the explicit-only trigger, the checks it walks through,
 * the verdict bound to one commit hash, and the rule that code never goes
 * to another provider without the user's approval.
 */
describe("the release-check starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const body = readFileSync(join(dir, "release-check", "SKILL.md"), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("release-check");
    const { manifest } = parseSkillFile(body);
    expect(manifest.name).toBe("release-check");
    expect(manifest.description).toMatch(/^Only when the user explicitly asks/);
  });

  it("runs only on an explicit release request, never in normal work", () => {
    expect(body).toMatch(/description:.*explicitly asks to prepare a release/);
    expect(body).toMatch(/Do not run it for normal coding work/);
  });

  it("walks through the release checks", () => {
    expect(body).toMatch(/\*\*Clean build from a fresh checkout\.\*\*/);
    expect(body).toMatch(/verify\.run/);
    expect(body).toMatch(/npm pack --dry-run/);
    expect(body).toMatch(/\*\*Metadata\.\*\*/);
    expect(body).toMatch(/\*\*Stubs and placeholders\.\*\*/);
    expect(body).toMatch(/empty test bodies/);
    expect(body).toMatch(/\*\*Secrets and private data\.\*\*/);
    expect(body).toMatch(/\*\*Edge cases\.\*\*/);
  });

  it("ties the verdict to one commit hash and voids it after any edit", () => {
    expect(body).toMatch(/Record the commit hash/);
    expect(body).toMatch(/the verdict is void/);
    expect(body).toMatch(/Never carry a PASS over to a newer commit/);
  });

  it("never sends code to another provider without asking", () => {
    expect(body).toMatch(/must not leave the machine/);
    expect(body).toMatch(/Asking to publish is not permission to send the code anywhere/);
    expect(body).toMatch(/second review: not done/);
  });

  it("keeps implementation, tests and release readiness apart and never publishes", () => {
    expect(body).toMatch(/Implementation complete \/ tests passing \/ release-ready/);
    expect(body).toMatch(/Do not publish, tag, push or upload anything/);
  });
});
