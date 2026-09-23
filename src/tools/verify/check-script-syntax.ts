/**
 * Syntax checkers for the script-shaped files: JavaScript / JSON
 * (in-process first, then one `node --check` per file), Python and shell.
 *
 * Every subprocess checker runs one file per invocation. `node --check
 * a.js b.js` checks only `a.js` and says nothing about it — a fan-out
 * review once passed four files on that basis — so a multi-file check is
 * a loop here, never a longer argv.
 *
 * Python is checked with the builtin `compile()` rather than
 * `py_compile`: `py_compile` writes `__pycache__/*.pyc` next to the file,
 * which is exactly the clutter verification must not leave in a
 * deliverable. `compile()` parses and writes nothing.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { checkFileParses } from "../os/fs-parse-check.js";
import { type SyntaxFileResult, tailOfOutput } from "./syntax-check-types.js";

export interface CheckerRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The binary is not installed (ENOENT). */
  readonly missing: boolean;
  readonly timedOut: boolean;
}

const CHECKER_TIMEOUT_MS = 60_000;
const CHECKER_OUTPUT_CAP = 64 * 1024;

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Run one checker process and collect its output. Never rejects: a
 * missing binary comes back as `missing: true`, so the caller can say
 * "no checker" instead of throwing at the model.
 */
export function runChecker(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CheckerRun> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Belt and braces for any interpreter that caches bytecode.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, options.timeoutMs ?? CHECKER_TIMEOUT_MS);
    const finish = (run: CheckerRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < CHECKER_OUTPUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < CHECKER_OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({
        exitCode: null,
        stdout,
        stderr: stderr.length > 0 ? stderr : String(err),
        missing: isMissingBinary(err),
        timedOut,
      });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, missing: false, timedOut });
    });
  });
}

/** `node --check` decorates stderr with `<file>:<line>` then the error line. */
function describeNodeCheckFailure(run: CheckerRun): string {
  const text = run.stderr.replace(/\r\n/g, "\n");
  const line = text.match(/^[^\n]*:(\d+)\n/)?.[1];
  const error = text.match(/^(\w*Error: [^\n]*)$/m)?.[1];
  if (error === undefined) return tailOfOutput(text, 4);
  return line === undefined ? error : `${error} (line ${line})`;
}

/** One `node --check` for exactly one file. */
async function nodeCheck(
  file: string,
  pathToCheck: string,
): Promise<SyntaxFileResult> {
  const run = await runChecker(process.execPath, ["--check", pathToCheck]);
  if (run.missing) {
    return { file, ok: null, checker: "none", error: "node not found" };
  }
  if (run.timedOut) {
    return { file, ok: null, checker: "node --check", error: "timed out" };
  }
  if (run.exitCode === 0) return { file, ok: true, checker: "node --check" };
  return {
    file,
    ok: false,
    checker: "node --check",
    error: describeNodeCheckFailure(run),
  };
}

/**
 * JavaScript / JSON: the write-time parse check first (in-process, no
 * subprocess), then `node --check` for what plain-script parsing cannot
 * judge — ES modules above all, which the in-process check skips.
 */
export async function checkJavaScriptFile(
  file: string,
  content: string,
): Promise<SyntaxFileResult> {
  const parsed = checkFileParses(file, content);
  if (parsed.kind === "ok") return { file, ok: true, checker: "node-vm" };
  if (parsed.kind === "error") {
    return { file, ok: false, checker: "node-vm", error: parsed.message };
  }
  if (extname(file).toLowerCase() === ".json") {
    return {
      file,
      ok: null,
      checker: "none",
      error: "too large to parse in-process",
    };
  }
  return nodeCheck(file, file);
}

/**
 * A block of JavaScript that is not a file of its own (an inline
 * `<script>`). The in-process check runs on the text; when it cannot
 * judge the block, the text goes to `node --check` through a temp file
 * in the OS temp dir — never next to the deliverable.
 */
export async function checkJavaScriptSource(
  label: string,
  code: string,
  options: { module: boolean },
): Promise<SyntaxFileResult> {
  const pseudo = `${label}${options.module ? ".mjs" : ".js"}`;
  const parsed = checkFileParses(pseudo, code);
  if (parsed.kind === "ok") return { file: label, ok: true, checker: "node-vm" };
  if (parsed.kind === "error") {
    return { file: label, ok: false, checker: "node-vm", error: parsed.message };
  }
  const dir = await mkdtemp(join(tmpdir(), "atag-verify-inline-"));
  try {
    const temp = join(dir, `${basename(label).replace(/[^\w.-]/g, "_")}.${options.module ? "mjs" : "cjs"}`);
    await writeFile(temp, code, "utf8");
    const verdict = await nodeCheck(label, temp);
    return verdict;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PYTHON_COMPILE =
  "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')";

/** Python: `compile()` parses without writing bytecode. */
export async function checkPythonFile(file: string): Promise<SyntaxFileResult> {
  for (const python of ["python3", "python"]) {
    const run = await runChecker(python, ["-c", PYTHON_COMPILE, file]);
    if (run.missing) continue;
    const checker = `${python} compile()`;
    if (run.timedOut) return { file, ok: null, checker, error: "timed out" };
    if (run.exitCode === 0) return { file, ok: true, checker };
    return { file, ok: false, checker, error: tailOfOutput(run.stderr, 4) };
  }
  return { file, ok: null, checker: "none", error: "python3 not found" };
}

/** Shell: `bash -n`, or `sh -n` where bash is absent. */
export async function checkShellFile(file: string): Promise<SyntaxFileResult> {
  for (const shell of ["bash", "sh"]) {
    const run = await runChecker(shell, ["-n", file]);
    if (run.missing) continue;
    const checker = `${shell} -n`;
    if (run.timedOut) return { file, ok: null, checker, error: "timed out" };
    if (run.exitCode === 0) return { file, ok: true, checker };
    return { file, ok: false, checker, error: tailOfOutput(run.stderr, 4) };
  }
  return { file, ok: null, checker: "none", error: "bash not found" };
}
