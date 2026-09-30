import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { checkShellCommandGuard } from "./shell-command-guard/index.js";
import { renderShellExit, type ShellCommandFacts } from "./shell-result.js";

/**
 * The ingestion cap on an `os.shell.run` result. The compressor runs
 * inside the tool, so what it drops here never reaches the transcript —
 * these are the numbers that decide whether the model gets to see its
 * own command's output.
 */

const CHAR_CAP_ENV = "ATOMIC_AGENT_SHELL_TOOL_RESULT_CHAR_CAP";
const TAIL_LINES_ENV = "ATOMIC_AGENT_SHELL_TOOL_RESULT_TAIL_LINES";

function facts(cmd: string, gog = false): ShellCommandFacts {
  return {
    cmd,
    args: [],
    rawArgs: [],
    cwd: "/tmp",
    shell: false,
    commandLine: cmd,
    noArguments: false,
    gog,
    guard: checkShellCommandGuard({ cmd, rawArgs: [], cwd: "/tmp" }),
  };
}

/** `count` numbered lines, each long enough that 400 chars runs out fast. */
function longOutput(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `line ${i + 1}: ${"x".repeat(40)}`,
  ).join("\n");
}

function run(cmd: string, stdout: string, gog = false) {
  return renderShellExit(
    facts(cmd, gog),
    { exitCode: 0, signal: null, durationMs: 5 },
    { stdout, stderr: "", truncated: false },
  );
}

function summaryLines(summary: string): number {
  return summary.split("\n").length;
}

describe("os.shell.run ingestion cap", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved[CHAR_CAP_ENV] = process.env[CHAR_CAP_ENV];
    saved[TAIL_LINES_ENV] = process.env[TAIL_LINES_ENV];
    delete process.env[CHAR_CAP_ENV];
    delete process.env[TAIL_LINES_ENV];
    resetConfigCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  });

  it("keeps far more than the compressor's bare 400 chars / 12 lines", () => {
    const result = run("npm", longOutput(300));
    // The old behaviour (no options passed) was 12 tail lines capped at
    // 400 characters — a `git diff` through the shell came back unusable.
    expect(summaryLines(result.summary)).toBeGreaterThan(100);
    expect(result.summary.length).toBeGreaterThan(5_000);
    expect(result.summary).toContain("line 300:");
    expect(result.summary).toContain("line 100:");
  });

  it("uses the configured defaults for a non-gog command", () => {
    const { shellToolResultCharCap, shellToolResultTailLines } =
      getConfig().agent;
    expect(shellToolResultCharCap).toBe(16_000);
    expect(shellToolResultTailLines).toBe(500);

    const result = run("npm", longOutput(600));
    // 500 tail lines, plus the `… [omitted N lines]` marker and the two
    // header lines the renderer puts above the body.
    expect(summaryLines(result.summary)).toBeLessThanOrEqual(504);
    expect(result.summary.length).toBeLessThanOrEqual(16_000);
    expect(result.truncated).toBe(true);
  });

  it("honours the env knobs", () => {
    process.env[CHAR_CAP_ENV] = "1200";
    process.env[TAIL_LINES_ENV] = "20";
    resetConfigCache();

    const result = run("npm", longOutput(300));
    expect(summaryLines(result.summary)).toBeLessThanOrEqual(24);
    expect(result.summary.length).toBeLessThanOrEqual(1_200);
    // Lower bounds too, or the unfixed 12-line / 400-char behaviour
    // satisfies this test and it proves nothing about the knobs.
    expect(summaryLines(result.summary)).toBeGreaterThan(13);
    expect(result.summary.length).toBeGreaterThan(400);
  });

  it("keeps the end of the output when the char cap cuts, not the start", () => {
    // The line the command was run for — the verdict under the log.
    const verdict = "Tests  948 passed (951)";
    process.env[CHAR_CAP_ENV] = "400";
    process.env[TAIL_LINES_ENV] = "500";
    resetConfigCache();

    const result = run("npm", `${longOutput(300)}\n${verdict}`);
    expect(result.summary.length).toBeLessThanOrEqual(400);
    expect(result.truncated).toBe(true);
    // The compressor's bare cut keeps the *first* 385 characters of a
    // tail it just took, which drops exactly this.
    expect(result.summary).toContain(verdict);
    expect(result.summary.endsWith(verdict)).toBe(true);
    expect(result.summary).not.toContain("line 1:");
  });

  it("keeps the error signature above the cut when the end is kept", () => {
    process.env[CHAR_CAP_ENV] = "400";
    resetConfigCache();

    const result = renderShellExit(
      facts("npm"),
      { exitCode: 1, signal: null, durationMs: 5 },
      {
        stdout: `error: the one line that names it\n${longOutput(300)}\nlast line here`,
        stderr: "",
        truncated: false,
      },
    );
    expect(result.summary.startsWith("key: error: the one line that names it")).toBe(
      true,
    );
    expect(result.summary.endsWith("last line here")).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(400);
  });

  it("clamps the env knobs to their bounds", () => {
    process.env[CHAR_CAP_ENV] = "1";
    process.env[TAIL_LINES_ENV] = "0";
    resetConfigCache();
    expect(getConfig().agent.shellToolResultCharCap).toBe(400);
    expect(getConfig().agent.shellToolResultTailLines).toBe(12);

    process.env[CHAR_CAP_ENV] = "99999999";
    process.env[TAIL_LINES_ENV] = "99999999";
    resetConfigCache();
    expect(getConfig().agent.shellToolResultCharCap).toBe(1_000_000);
    expect(getConfig().agent.shellToolResultTailLines).toBe(100_000);
  });

  it("falls back to the default when the env value is not a number", () => {
    process.env[CHAR_CAP_ENV] = "lots";
    resetConfigCache();
    expect(getConfig().agent.shellToolResultCharCap).toBe(16_000);
  });

  it("leaves gog output on its own far larger options", () => {
    // 1000 lines is past the new non-gog tail (500) but well inside
    // gog's 10 000, and the whole body is inside gog's 64 KB.
    const result = run("gog", longOutput(1_000), true);
    expect(summaryLines(result.summary)).toBeGreaterThan(900);
    expect(result.summary).toContain("line 1:");

    // And the knobs do not reach it.
    process.env[TAIL_LINES_ENV] = "20";
    process.env[CHAR_CAP_ENV] = "400";
    resetConfigCache();
    const capped = run("gog", longOutput(1_000), true);
    expect(summaryLines(capped.summary)).toBe(summaryLines(result.summary));
  });
});
