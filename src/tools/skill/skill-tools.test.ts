import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import {
  renderToolResultBody,
  toolResultTurn,
} from "../../session/conversation-turn.js";
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

  /**
   * A skill whose script prints `lines` numbered lines, then exits 3.
   * `last` is printed after them, as a failing script's final word —
   * with no trailing newline, the shape a script that ends mid-line
   * produces, when `newlineAtEnd` is false. `blanks` double-spaces the
   * log, the shape that separates blank lines the compressor deletes
   * from the lines the omission banner counts.
   */
  async function installLoud(
    lines: number,
    last = "",
    newlineAtEnd = true,
    blanks = false,
  ): Promise<SkillRegistry> {
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
        `const gap = ${blanks ? "'\\n'" : "''"};`,
        "for (let i = 1; i <= total; i++) out += `line ${i} ${pad}\\n` + gap;",
        "process.stdout.write(out);",
        `const last = ${JSON.stringify(last)};`,
        `if (last) process.stdout.write(last + ${newlineAtEnd ? "'\\n'" : "''"});`,
        // Not process.exit(): it would cut the pipe before it flushed.
        "process.exitCode = 3;",
      ].join("\n"),
      "utf8",
    );
    const registry = new SkillRegistry({ globalDir: global, projectDir: null });
    await registry.refresh();
    return registry;
  }

  /** A skill whose script writes one line of `width` chars, no newline. */
  async function installOneLine(width: number): Promise<SkillRegistry> {
    const skills = await installLoud(0);
    await writeFile(
      join(global, "loud", "scripts", "loud.js"),
      [
        `const filler = 'z'.repeat(${width});`,
        "process.stdout.write('START-MARKER' + filler + 'END-MARKER');",
        "process.exitCode = 3;",
      ].join("\n"),
      "utf8",
    );
    await skills.refresh();
    return skills;
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

  /**
   * What the MODEL is given for a result, not what the tool returned:
   * `renderToolResultBody` caps the summary again at render time, and
   * it keeps the head, so a summary that overruns that cap loses the
   * tail this tool works to preserve. Asserting here is the only way to
   * see the whole path. `inCurrentMacroTurn` is inert for this tool —
   * it has no freshness branch in `renderToolResultBody`, so a fresh
   * result and an aged one render identically — and is passed only to
   * show the most generous case still holds.
   */
  function rendered(result: CompressedToolResult): string {
    return renderToolResultBody(
      toolResultTurn({
        tool: result.tool,
        status: result.status,
        summary: result.summary,
        truncated: result.truncated,
      }),
      { inCurrentMacroTurn: true },
    );
  }

  /** The header, wherever the compressor's `key: …` line puts it. */
  const HEADER_RE = /(^|\n)# loud\/loud\.js\nexit: 3(\n|$)/;

  /**
   * How many lines the omission banner says went. The rendered body is
   * the two header lines, the banner, then what survived — all of them
   * non-blank, which is what the banner counts.
   */
  function bannerLines(body: string): number {
    const found = /… \[omitted (\d+) earlier lines, \d+ characters\]/.exec(
      body,
    );
    return Number(found?.[1]);
  }

  it("skill.run_script keeps the exit line and the log tail", async () => {
    const skills = await installLoud(150, "FINAL-STATE-MARKER");
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    expect(result.status).toBe("error");
    expect(result.details.exitCode).toBe(3);
    const body = rendered(result);
    // The exit code is the first thing the model needs and it lives in
    // the header, which the compressor's 12-line tail used to drop.
    expect(body).toMatch(HEADER_RE);
    // Far more than the old 400-char / 12-line budget, and the END of
    // the log — the part that says how the run finished.
    expect(body).toContain("FINAL-STATE-MARKER");
    expect(body).toContain("line 150 ");
    expect(body).toContain("line 20 ");
    expect(body).not.toContain("rendering-truncated");
    expect(body.length).toBeGreaterThan(6_000);
    expect(result.truncated).toBe(false);
  });

  it("skill.run_script keeps the exit line when the body overflows", async () => {
    const skills = await installLoud(3_000, "FINAL-STATE-MARKER");
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    const body = rendered(result);
    expect(body).toMatch(HEADER_RE);
    expect(body).toContain("… [omitted ");
    // Overflow drops the head of the log, never its tail — and the
    // render cap must not undo that.
    expect(body).toContain("FINAL-STATE-MARKER");
    expect(body).toContain("line 3000 ");
    expect(body).not.toContain("line 1 x");
    expect(body).not.toContain("rendering-truncated");
    expect(body).not.toContain("… [truncated]");
    // A result that lost 2 700 lines must not claim to be complete.
    expect(result.truncated).toBe(true);
    // What survives starts at a line boundary, never mid-token.
    expect(body).toMatch(/\n… \[omitted[^\n]*\]\nline \d+ x/);
    expect(bannerLines(body)).toBe(3_001 - (body.split("\n").length - 3));
  });

  it("skill.run_script counts the same with no trailing newline", async () => {
    // Output that ends mid-line is the shape that made an earlier cut
    // spend a line of the budget on the empty string after the last
    // newline, so the banner was one line off.
    const skills = await installLoud(3_000, "FINAL-STATE-MARKER", false);
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    const body = rendered(result);
    expect(body).toContain("FINAL-STATE-MARKER");
    expect(bannerLines(body)).toBe(3_001 - (body.split("\n").length - 3));
  });

  it("skill.run_script counts the lines the model actually loses", async () => {
    // The compressor deletes blank lines from the body after the
    // banner is written, so a banner counting them states a number the
    // model cannot reconcile with the lines it received.
    const skills = await installLoud(1_500, "FINAL-STATE-MARKER", true, true);
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    const body = rendered(result);
    expect(body).toContain("FINAL-STATE-MARKER");
    // 1 500 numbered lines + the marker; the blank line after each one
    // is not a line the model is ever shown.
    expect(bannerLines(body)).toBe(1_501 - (body.split("\n").length - 3));
  });

  it("skill.run_script names a single line too long to cut", async () => {
    // No line boundary to cut on: the banner must not report a 50 KB
    // cut through the middle of a token as "0 earlier lines" of loss.
    const skills = await installOneLine(60_000);
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    const body = rendered(result);
    expect(body).toMatch(HEADER_RE);
    expect(body).toContain("one line is longer than this result's budget");
    expect(body).not.toContain("omitted 0 earlier lines");
    expect(body).toContain("END-MARKER");
    expect(body).not.toContain("START-MARKER");
    expect(result.truncated).toBe(true);
    const cut = /its first (\d+) characters are omitted/.exec(body);
    expect(Number(cut?.[1])).toBeGreaterThan(50_000);
  });

  it("skill.run_script keeps the exit line past the `key:` signature", async () => {
    // A failing script — the case this budget exists for — usually
    // prints something the compressor picks up as its signature line,
    // which lands above the header.
    const skills = await installLoud(150, "Error: boom");
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    const body = rendered(result);
    expect(body.startsWith("key: Error: boom")).toBe(true);
    expect(body).toMatch(HEADER_RE);
    expect(body).toContain("line 150 ");
  });

  it("skill.run_script says when the runner never captured the end", async () => {
    // Past `maxOutputBytes` the runner keeps the HEAD of the stream, so
    // the end of the log is gone before this tool sees it — and the
    // omission banner alone would claim only earlier output is missing.
    const skills = await installLoud(8_000, "FINAL-STATE-MARKER");
    const result = await approvingTool(skills).run(
      { skill: "loud", script: "loud.js" },
      makeCtx(base),
    );
    const body = rendered(result);
    expect(result.details.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(body).toMatch(HEADER_RE);
    expect(body).toContain("the end of the log is missing");
    expect(body).not.toContain("FINAL-STATE-MARKER");
    expect(body).not.toContain("rendering-truncated");
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
    const result = await approvingTool(skills).run(
      { skill: "echo", script: "say.js", args: ["hi"] },
      makeCtx(base),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("said hi");
    expect(result.details.exitCode).toBe(0);
  });
});
