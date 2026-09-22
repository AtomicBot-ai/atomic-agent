import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildSkillViewTool } from "./skill-view.js";
import { buildSkillRunScriptTool } from "./skill-run-script.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("skill tools", () => {
  let base: string;
  let global: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-skill-tools-"));
    global = join(base, "skills");
    await mkdir(global, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function installEcho(): Promise<SkillRegistry> {
    const skillDir = join(global, "echo");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: echo",
        'description: "Echoes back"',
        "version: 0.1.0",
        "requires_scripts: [say.js]",
        "---",
        "",
        "Echo playbook body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(skillDir, "scripts", "say.js"),
      "process.stdout.write('said ' + process.argv.slice(2).join(' '));",
      "utf8",
    );
    const registry = new SkillRegistry({ globalDir: global, projectDir: null });
    await registry.refresh();
    return registry;
  }

  async function installGogWorkspace(): Promise<SkillRegistry> {
    const skillDir = join(global, "gog-workspace");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: gog-workspace",
        'description: "Google Workspace through gog"',
        "version: 0.1.0",
        "requires_scripts: [check-gog.sh]",
        "---",
        "",
        "gog playbook body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(skillDir, "scripts", "check-gog.sh"),
      "printf 'gog auth doctor succeeded.\\n'",
      "utf8",
    );
    const registry = new SkillRegistry({ globalDir: global, projectDir: null });
    await registry.refresh();
    return registry;
  }

  /** A skill whose script prints `lines` numbered lines, then exits 3. */
  async function installLoud(lines: number): Promise<SkillRegistry> {
    const skillDir = join(global, "loud");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: loud",
        'description: "Prints a long log"',
        "version: 0.1.0",
        "requires_scripts: [loud.js]",
        "---",
        "",
        "Loud playbook body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(skillDir, "scripts", "loud.js"),
      [
        `const total = ${lines};`,
        "const pad = 'x'.repeat(40);",
        "let out = '';",
        "for (let i = 1; i <= total; i++) out += `line ${i} ${pad}\\n`;",
        "process.stdout.write(out);",
        // Not process.exit(): it would cut the pipe before it flushed.
        "process.exitCode = 3;",
      ].join("\n"),
      "utf8",
    );
    const registry = new SkillRegistry({ globalDir: global, projectDir: null });
    await registry.refresh();
    return registry;
  }

  function approvingTool(skills: SkillRegistry) {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return buildSkillRunScriptTool(skills, {
      approvals: gate,
      approvalRequired: true,
    });
  }

  it("skill.run_script keeps the exit line and the log tail", async () => {
    const skills = await installLoud(200);
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    expect(result.status).toBe("error");
    expect(result.details.exitCode).toBe(3);
    // The header is the first thing the model reads, and the exit code
    // lives there: the compressor's 12-line tail used to drop it.
    expect(result.summary.startsWith("# loud/loud.js\nexit: 3")).toBe(true);
    // Far more than the old 400-char / 12-line budget, and the END of
    // the log — the part that says how the run finished.
    expect(result.summary).toContain("line 200 ");
    expect(result.summary).toContain("line 20 ");
    expect(result.summary.length).toBeGreaterThan(9_000);
    expect(result.truncated).toBe(false);
  });

  it("skill.run_script keeps the exit line when the body overflows", async () => {
    const skills = await installLoud(3_000);
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    expect(result.summary.startsWith("# loud/loud.js\nexit: 3")).toBe(true);
    expect(result.summary).toContain("… [omitted ");
    // Overflow drops the head of the log, never its tail.
    expect(result.summary).toContain("line 3000 ");
    expect(result.summary).not.toContain("line 1 x");
    expect(result.summary.length).toBeLessThanOrEqual(16_000);
  });

  it("skill.view returns body and emits skillLoaded patch", async () => {
    const skills = await installEcho();
    const tool = buildSkillViewTool(skills);
    const result = await tool.run({ name: "echo" }, makeCtx(base));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Echo playbook body");
    const loaded = result.details.skillLoaded as { name: string; body: string };
    expect(loaded.name).toBe("echo");
    expect(loaded.body).toContain("Echo playbook body");
  });

  it("skill.run_script denies when approval gate rejects", async () => {
    const skills = await installEcho();
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied"),
    });
    const tool = buildSkillRunScriptTool(skills, {
      approvals: gate,
      approvalRequired: true,
    });
    await expect(
      tool.run({ skill: "echo", script: "say.js" }, makeCtx(base)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("skill.run_script auto-approves the read-only gog setup check", async () => {
    const skills = await installGogWorkspace();
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied"),
    });
    const tool = buildSkillRunScriptTool(skills, {
      approvals: gate,
      approvalRequired: true,
    });
    const result = await tool.run(
      { skill: "gog-workspace", script: "check-gog.sh" },
      makeCtx(base),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("gog auth doctor succeeded");
  });

  it("skill.run_script runs an allowed script after approval", async () => {
    const skills = await installEcho();
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildSkillRunScriptTool(skills, {
      approvals: gate,
      approvalRequired: true,
    });
    const result = await tool.run(
      { skill: "echo", script: "say.js", args: ["hi"] },
      makeCtx(base),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("said hi");
    expect(result.details.exitCode).toBe(0);
  });
});
