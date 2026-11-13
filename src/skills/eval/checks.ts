import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCommandEnv } from "../../sandbox/command-env.js";
import type { SkillEvalCheck, SkillEvalCheckType } from "./task-set.js";

/** One check's verdict, as stored in a run result. */
export interface SkillEvalCheckOutcome {
  type: SkillEvalCheckType;
  passed: boolean;
  /** Short reason, for a person reading why a run failed. */
  detail: string;
}

export interface RunChecksInput {
  /** The agent's final reply; empty when it gave none. */
  answer: string;
  /** The run's working folder; `command` checks run here. */
  workingDir: string;
}

/**
 * Run every check against one run. All checks are run (not stopped at the
 * first failure) so a result shows each one's verdict.
 */
export async function runChecks(
  checks: readonly SkillEvalCheck[],
  input: RunChecksInput,
): Promise<SkillEvalCheckOutcome[]> {
  const outcomes: SkillEvalCheckOutcome[] = [];
  for (const check of checks) outcomes.push(await runCheck(check, input));
  return outcomes;
}

export async function runCheck(
  check: SkillEvalCheck,
  input: RunChecksInput,
): Promise<SkillEvalCheckOutcome> {
  switch (check.type) {
    case "exact": {
      const got = normalizeAnswer(input.answer, check.caseSensitive);
      const want = normalizeAnswer(check.expected, check.caseSensitive);
      return {
        type: "exact",
        passed: got === want,
        detail: got === want ? "matched" : `expected ${JSON.stringify(want)}, got ${JSON.stringify(clip(got))}`,
      };
    }
    case "regex": {
      const passed = new RegExp(check.pattern, check.flags).test(input.answer);
      return { type: "regex", passed, detail: passed ? "matched" : `no match for /${check.pattern}/${check.flags}` };
    }
    case "command":
      return runCommandCheck(check.run, check.timeoutMs, input);
  }
}

/**
 * What an `exact` check compares: trimmed, one wrapping pair of quotes,
 * backticks or `**` removed, one trailing period removed, runs of
 * whitespace collapsed, lower-cased unless `caseSensitive`. Models wrap a
 * bare answer in markdown or end it with a period; neither should fail it.
 */
export function normalizeAnswer(text: string, caseSensitive = false): string {
  let s = text.trim();
  for (const [open, close] of [["**", "**"], ["`", "`"], ['"', '"'], ["'", "'"]] as const) {
    if (s.length >= open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim();
    }
  }
  if (s.endsWith(".")) s = s.slice(0, -1).trimEnd();
  s = s.replace(/\s+/g, " ");
  return caseSensitive ? s : s.toLowerCase();
}

/**
 * Run `command` through the platform shell in the run's folder. The reply
 * goes in on stdin and in a temp file named by `SKILL_EVAL_ANSWER_FILE`.
 * The environment is filtered like `os.shell.run` (`buildCommandEnv`), so
 * provider keys do not reach a check.
 */
async function runCommandCheck(
  command: string,
  timeoutMs: number,
  input: RunChecksInput,
): Promise<SkillEvalCheckOutcome> {
  const answerDir = await mkdtemp(join(tmpdir(), "atomic-skill-eval-answer-"));
  const answerFile = join(answerDir, "answer.txt");
  try {
    await writeFile(answerFile, input.answer, "utf8");
    const result = await spawnShell(command, {
      cwd: input.workingDir,
      env: { ...buildCommandEnv(process.env), SKILL_EVAL_ANSWER_FILE: answerFile },
      stdin: input.answer,
      timeoutMs,
    });
    if (result.timedOut) return { type: "command", passed: false, detail: `timed out after ${timeoutMs}ms` };
    if (result.error) return { type: "command", passed: false, detail: `could not run: ${result.error}` };
    const passed = result.exitCode === 0;
    const tail = clip(result.output.trim(), 300);
    return {
      type: "command",
      passed,
      detail: passed ? "exit 0" : `exit ${result.exitCode ?? "signal"}${tail ? `: ${tail}` : ""}`,
    };
  } finally {
    await rm(answerDir, { recursive: true, force: true });
  }
}

interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  error: string | null;
}

function spawnShell(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
): Promise<ShellResult> {
  return new Promise((resolveResult) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    const keep = (chunk: Buffer): void => {
      // The last few KB are what explains a failure; never hold more.
      output = (output + chunk.toString("utf8")).slice(-4096);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => done({ exitCode: null, output, timedOut: false, error: err.message }));
    child.on("close", (code) => done({ exitCode: code, output, timedOut, error: null }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
  });
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
