/**
 * Syntax checkers for the script-shaped files: JavaScript / JSON
 * (in-process first, then one `node --check` per file), Python and shell.
 *
 * Every subprocess checker runs one file per invocation. `node --check
 * a.js b.js` checks only `a.js` and says nothing about it — a fan-out
 * review once passed four files on that basis — so a multi-file check is
 * a loop here, never a longer argv.
 *
 * `node --check` needs a real Node.js. In a release build (a single
 * executable application) `process.execPath` is the agent binary, which
 * treats `--check` as an unknown CLI command, so there the checker is
 * `node` from PATH; without one the file is reported unchecked, never
 * failed. A non-zero exit that is not a SyntaxError is likewise "the
 * checker did not run", not a verdict on the file.
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

import { isSeaBuild } from "../../runtime/self-invocation.js";
import { checkFileParses } from "../os/fs/fs-parse-check.js";
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

/**
 * The Node.js to run `node --check` with: this process when it is Node
 * itself, `node` from PATH when this process is the release binary.
 */
export function nodeForSyntaxCheck(
  sea: boolean = isSeaBuild(),
  execPath: string = process.execPath,
): string {
  return sea ? "node" : execPath;
}

const NO_NODE_FOR_CHECK =
  "no Node.js found on PATH to run node --check (release builds cannot use their own binary for it)";

/** One `node --check` for exactly one file. */
export async function nodeCheck(
  file: string,
  pathToCheck: string,
  node: string = nodeForSyntaxCheck(),
): Promise<SyntaxFileResult> {
  const run = await runChecker(node, ["--check", pathToCheck]);
  if (run.missing) {
    return { file, ok: null, checker: "none", error: NO_NODE_FOR_CHECK };
  }
  if (run.timedOut) {
    return { file, ok: null, checker: "node --check", error: "timed out" };
  }
  if (run.exitCode === 0) return { file, ok: true, checker: "node --check" };
  // Only a SyntaxError is a verdict on the file. Anything else (a binary
  // that does not know `--check`, a crash) means the check never ran.
  if (!/\bSyntaxError\b/.test(run.stderr)) {
    return {
      file,
      ok: null,
      checker: "node --check",
      error: `node --check did not run: ${tailOfOutput(`${run.stderr}\n${run.stdout}`, 2) || `exit ${run.exitCode}`}`,
    };
  }
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

/** The process runner the Python and shell checkers use (swapped in tests). */
export type CheckerRunner = typeof runChecker;

export interface InterpreterOptions {
  readonly run?: CheckerRunner;
  readonly platform?: NodeJS.Platform;
}

interface Interpreter {
  readonly cmd: string;
  /** Arguments that come before the checker's own (`py -3`). */
  readonly args: readonly string[];
  readonly label: string;
}

interface InterpreterKind {
  readonly name: string;
  candidates(platform: NodeJS.Platform): readonly Interpreter[];
  /** Arguments of a trivial run that only a working interpreter passes. */
  readonly probeArgs: readonly string[];
  probeOk(run: CheckerRun): boolean;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * A binary on PATH is not a working interpreter. On Windows `python3` is
 * often the Microsoft Store alias (prints a Store notice, exits 9009) and
 * `bash` is the WSL launcher in System32 (exits 1 when no distribution has
 * /bin/bash). Neither raises ENOENT, so each candidate is probed with a
 * trivial run first; one that fails the probe is skipped, not trusted.
 * The probe matches no message or exit code, both of which are localized
 * or generic.
 */
const PYTHON_KIND: InterpreterKind = {
  name: "python",
  candidates: (platform) => [
    { cmd: "python3", args: [], label: "python3" },
    { cmd: "python", args: [], label: "python" },
    ...(platform === "win32" ? [{ cmd: "py", args: ["-3"], label: "py -3" }] : []),
  ],
  // Prints the major version: rejects stubs and Python 2 alike.
  probeArgs: ["-c", "import sys; sys.stdout.write(str(sys.version_info[0]))"],
  probeOk: (run) => run.exitCode === 0 && run.stdout.trim() === "3",
};

const SHELL_KIND: InterpreterKind = {
  name: "shell",
  // On Windows any `sh` on PATH is a native port (Git for Windows, MSYS2,
  // Cygwin) that takes Windows paths; System32 `bash` is the WSL launcher,
  // whose Linux bash cannot open `C:\...` even when a distribution exists.
  candidates: (platform) =>
    (platform === "win32" ? ["sh", "bash"] : ["bash", "sh"]).map((cmd) => ({
      cmd,
      args: [],
      label: cmd,
    })),
  probeArgs: ["-c", "exit 0"],
  probeOk: (run) => run.exitCode === 0,
};

/**
 * Resolved interpreters, per runner and kind. A found interpreter is kept
 * for the process; "none found" is not, so one installed mid-session is
 * picked up by the next check.
 */
const resolvedInterpreters = new WeakMap<
  CheckerRunner,
  Map<string, Promise<Interpreter | null>>
>();

function resolveInterpreter(
  kind: InterpreterKind,
  run: CheckerRunner,
  platform: NodeJS.Platform,
): Promise<Interpreter | null> {
  let byKind = resolvedInterpreters.get(run);
  if (byKind === undefined) {
    byKind = new Map();
    resolvedInterpreters.set(run, byKind);
  }
  const key = `${kind.name}:${platform}`;
  const cached = byKind.get(key);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<Interpreter | null> => {
    for (const candidate of kind.candidates(platform)) {
      const probe = await run(candidate.cmd, [...candidate.args, ...kind.probeArgs], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (probe.missing || probe.timedOut) continue;
      if (kind.probeOk(probe)) return candidate;
    }
    return null;
  })();
  const cache = byKind;
  cache.set(key, pending);
  const forget = (): void => {
    if (cache.get(key) === pending) cache.delete(key);
  };
  pending.then((found) => {
    if (found === null) forget();
  }, forget);
  return pending;
}

const PYTHON_COMPILE =
  "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')";

/** Exception class names are not localized. */
const PYTHON_SYNTAX_ERROR = /\b(?:SyntaxError|IndentationError|TabError)\b/;

/** bash: "syntax error"; dash: "Syntax error"; zsh: "parse error". */
const SHELL_SYNTAX_ERROR = /\b(?:syntax error|parse error)\b|\bunexpected\b/i;

function didNotRun(file: string, checker: string, run: CheckerRun): SyntaxFileResult {
  return {
    file,
    ok: null,
    checker,
    error: `${checker} did not run: ${tailOfOutput(`${run.stderr}\n${run.stdout}`, 2) || `exit ${run.exitCode}`}`,
  };
}

/**
 * Python: `compile()` parses without writing bytecode. Only a
 * SyntaxError (or a subclass) is a verdict on the file; any other
 * non-zero exit means the check did not run.
 */
export async function checkPythonFile(
  file: string,
  options: InterpreterOptions = {},
): Promise<SyntaxFileResult> {
  const run = options.run ?? runChecker;
  const python = await resolveInterpreter(PYTHON_KIND, run, options.platform ?? process.platform);
  if (python === null) {
    return { file, ok: null, checker: "none", error: "python3 not found" };
  }
  const checker = `${python.label} compile()`;
  const out = await run(python.cmd, [...python.args, "-c", PYTHON_COMPILE, file]);
  if (out.timedOut) return { file, ok: null, checker, error: "timed out" };
  if (out.exitCode === 0) return { file, ok: true, checker };
  if (out.missing || !PYTHON_SYNTAX_ERROR.test(out.stderr)) {
    return didNotRun(file, checker, out);
  }
  return { file, ok: false, checker, error: tailOfOutput(out.stderr, 4) };
}

/**
 * Shell: `bash -n`, or `sh -n` where bash is absent or broken (`sh`
 * first on Windows). A non-zero exit without a syntax-error message is
 * "the check did not run", not a verdict on the file.
 */
export async function checkShellFile(
  file: string,
  options: InterpreterOptions = {},
): Promise<SyntaxFileResult> {
  const run = options.run ?? runChecker;
  const shell = await resolveInterpreter(SHELL_KIND, run, options.platform ?? process.platform);
  if (shell === null) {
    return { file, ok: null, checker: "none", error: "bash not found" };
  }
  const checker = `${shell.label} -n`;
  const out = await run(shell.cmd, [...shell.args, "-n", file]);
  if (out.timedOut) return { file, ok: null, checker, error: "timed out" };
  if (out.exitCode === 0) return { file, ok: true, checker };
  if (out.missing || !SHELL_SYNTAX_ERROR.test(out.stderr)) {
    return didNotRun(file, checker, out);
  }
  return { file, ok: false, checker, error: tailOfOutput(out.stderr, 4) };
}
