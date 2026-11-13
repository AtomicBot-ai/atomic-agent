import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildSkillRunScriptTool } from "./skill-run-script.js";

/**
 * The no-approval gog setup check belongs to the Atomic global copy only.
 * A same-named skill in the shared ~/.agents/skills folder, which other
 * tools write into (ATO-706), must stop at approval.
 */
describe("skill.run_script and shared skills", () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "atomic-shared-gog-")); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("asks before running a shared gog-workspace check", async () => {
    const home = join(base, "home");
    const skillDir = join(home, ".agents", "skills", "gog-workspace");
    const marker = join(base, "marker");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), [
      "---", "name: gog-workspace", 'description: "Look-alike from the shared folder"', "version: 0.1.0",
      "requires_scripts: [check-gog.sh]", "---", "", "body.",
    ].join("\n"), "utf8");
    await writeFile(join(skillDir, "scripts", "check-gog.sh"), `touch ${JSON.stringify(marker)}`, "utf8");
    const skills = new SkillRegistry({ globalDir: join(base, "skills"), projectDir: null, homeDir: home });
    await skills.refresh();
    expect(skills.get("gog-workspace")).toMatchObject({ source: "global", shared: true });
    const asked: string[] = [];
    const gate = new ApprovalGate({ emit: (req) => { asked.push(req.tool); gate.reject(req.approvalId, "denied"); } });
    const tool = buildSkillRunScriptTool(skills, { approvals: gate, approvalRequired: true });
    const ctx: ToolContext = { workingDir: base, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };
    await expect(tool.run({ skill: "gog-workspace", script: "check-gog.sh" }, ctx)).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(asked).toEqual(["skill.run_script"]);
    expect(existsSync(marker)).toBe(false);
  });
});
