import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeAnswer, runCheck, runChecks } from "./checks.js";

/** A portable command: the running node with an inline script. */
function node(script: string): string {
  return `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`;
}

describe("normalizeAnswer", () => {
  it.each([
    ["  3  ", "3"],
    ["**3**", "3"],
    ["`Paris`", "paris"],
    ['"Paris."', "paris"],
    ["Paris.", "paris"],
    ["New   York\nCity", "new york city"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeAnswer(input)).toBe(expected);
  });

  it("keeps case when asked", () => {
    expect(normalizeAnswer("Paris", true)).toBe("Paris");
  });
});

describe("runCheck", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-eval-checks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("exact passes on a normalized match and explains a miss", async () => {
    const check = { type: "exact" as const, expected: "3", caseSensitive: false };
    expect((await runCheck(check, { answer: "**3**.", workingDir: dir })).passed).toBe(true);
    const miss = await runCheck(check, { answer: "4", workingDir: dir });
    expect(miss).toMatchObject({ passed: false, detail: 'expected "3", got "4"' });
  });

  it("regex matches the raw reply", async () => {
    const check = { type: "regex" as const, pattern: "\\b42\\b", flags: "" };
    expect((await runCheck(check, { answer: "it is 42 pages", workingDir: dir })).passed).toBe(true);
    expect((await runCheck(check, { answer: "421", workingDir: dir })).passed).toBe(false);
  });

  it("command runs in the working folder and passes on exit 0", async () => {
    writeFileSync(join(dir, "out.txt"), "hello");
    const check = { type: "command" as const, run: node("process.exit(require('fs').existsSync('out.txt') ? 0 : 1)"), timeoutMs: 10_000 };
    expect(await runCheck(check, { answer: "", workingDir: dir })).toMatchObject({ passed: true, detail: "exit 0" });
    rmSync(join(dir, "out.txt"));
    expect((await runCheck(check, { answer: "", workingDir: dir })).passed).toBe(false);
  });

  it("command gets the reply on stdin and in SKILL_EVAL_ANSWER_FILE", async () => {
    const viaFile = node("process.exit(require('fs').readFileSync(process.env.SKILL_EVAL_ANSWER_FILE,'utf8') === 'abc' ? 0 : 1)");
    expect((await runCheck({ type: "command", run: viaFile, timeoutMs: 10_000 }, { answer: "abc", workingDir: dir })).passed).toBe(true);
    const viaStdin = node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(s==='abc'?0:1))");
    expect((await runCheck({ type: "command", run: viaStdin, timeoutMs: 10_000 }, { answer: "abc", workingDir: dir })).passed).toBe(true);
  });

  it("command failure carries the exit code and output tail", async () => {
    const out = await runCheck(
      { type: "command", run: node("console.error('nope');process.exit(3)"), timeoutMs: 10_000 },
      { answer: "", workingDir: dir },
    );
    expect(out.passed).toBe(false);
    expect(out.detail).toMatch(/^exit 3: nope/);
  });

  it("command that runs too long fails as a timeout", async () => {
    const out = await runCheck(
      { type: "command", run: node("setTimeout(()=>{}, 20000)"), timeoutMs: 300 },
      { answer: "", workingDir: dir },
    );
    expect(out).toMatchObject({ passed: false, detail: "timed out after 300ms" });
  });

  it("command does not see provider keys", async () => {
    process.env.OPENAI_API_KEY = "sk-test-should-not-leak";
    try {
      const out = await runCheck(
        { type: "command", run: node("process.exit(process.env.OPENAI_API_KEY ? 1 : 0)"), timeoutMs: 10_000 },
        { answer: "", workingDir: dir },
      );
      expect(out.passed).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("runChecks reports every check, not just the first failure", async () => {
    const outcomes = await runChecks(
      [
        { type: "regex", pattern: "x", flags: "" },
        { type: "exact", expected: "abc", caseSensitive: false },
      ],
      { answer: "abc", workingDir: dir },
    );
    expect(outcomes.map((o) => o.passed)).toEqual([false, true]);
  });
});
