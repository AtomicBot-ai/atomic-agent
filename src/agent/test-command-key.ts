import { resolveUserPath } from "../tools/os/expand-home.js";
import { basenameCommand } from "../tools/os/shell-command-guard/index.js";

/**
 * Classification of an `os.shell.run` call as a recognized test-suite
 * invocation (issue #118). Deliberately explicit and conservative: only
 * the direct common forms are recognized; anything else returns `null`
 * and stays under the generic `ToolLoopTracker` detectors.
 *
 * Recognized runners:
 *  - `pytest` and `python -m pytest` / `python3 -m pytest`
 *  - `cargo test` and `go test`
 *  - `npm test`, `pnpm test`, `yarn test`, `bun test`
 *
 * The semantic `key` is built from the resolved working directory, the
 * runner, and the ordered suite/filter arguments. Execution-only
 * controls that provably do not change the selected tests — today only
 * the tool-level `timeoutMs` — are excluded, so a timeout-only
 * variation collapses to the same key. Everything else (cwd, suite
 * filters, feature flags, extra args) keeps runs distinct. Environment
 * overrides expressed on the command line (`FOO=1 pytest`) make the
 * leading token unrecognizable, so such runs fall back to the generic
 * detector rather than ever being conflated.
 */
export interface RecognizedTestCommand {
  /** Semantic identity: resolved cwd + runner + ordered filter args. */
  key: string;
  /** Human-readable command label for notices (e.g. `pytest -k auth`). */
  label: string;
  /** Absolute directory the command runs in (mirrors `os.shell.run`). */
  cwd: string;
}

/**
 * Mirrors the (private) metacharacter set in `src/tools/os/shell.ts`.
 * A command line carrying any of these runs through a subshell and may
 * be compound (`pytest | tee`, `cd x && pytest`), so it is never
 * classified — an exact mirror is not load-bearing, since a mismatch
 * only means "unrecognized", which degrades to the generic detector.
 */
const SHELL_METACHAR_RE = /[|&;<>$`(){}]/;

const NODE_TEST_RUNNERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

/**
 * Coerce the model-supplied `args` field the way the shell tool does:
 * missing → `[]`, `string[]` → coerced, JSON-stringified array literal →
 * parsed. Any other shape returns `null` (the tool would error anyway).
 */
function coerceArgs(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed.map((v) => String(v));
      } catch {
        // fall through
      }
    }
  }
  return null;
}

/** `~/venv/bin/pytest` → `pytest`, `PYTEST.EXE` → `pytest`. */
function normalizeRunnerName(token: string): string {
  const name = basenameCommand(token).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

/**
 * Classify a prospective tool call as a recognized test command, or
 * return `null` when it is anything else. Never throws on malformed
 * args. `workingDir` is the session working directory the shell tool
 * would resolve a relative/missing `cwd` against.
 */
export function classifyTestCommand(
  tool: string,
  args: unknown,
  workingDir: string,
): RecognizedTestCommand | null {
  if (tool !== "os.shell.run") return null;
  if (args === null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;

  const cmd = record.cmd;
  if (typeof cmd !== "string" || cmd.trim().length === 0) return null;
  // Subshell forms may be compound command lines; stay generic.
  if (SHELL_METACHAR_RE.test(cmd)) return null;

  const extra = coerceArgs(record.args);
  if (extra === null) return null;

  // Token view mirrors the shell tool's two execution modes: a
  // pre-joined command line in `cmd` (no separate args) is split on
  // whitespace exactly like the guard's tokenised view; the structured
  // form keeps argv boundaries. A whitespace-carrying `cmd` combined
  // with separate args is malformed — stay generic.
  let tokens: string[];
  if (/\s/.test(cmd.trim())) {
    if (extra.length > 0) return null;
    tokens = cmd.trim().split(/\s+/);
  } else {
    tokens = [cmd.trim(), ...extra];
  }

  const name = normalizeRunnerName(tokens[0]!);
  let runner: string | null = null;
  let rest: string[] = [];
  if (name === "pytest") {
    runner = "pytest";
    rest = tokens.slice(1);
  } else if (
    (name === "python" || name === "python3") &&
    tokens[1] === "-m" &&
    tokens[2] === "pytest"
  ) {
    runner = "pytest";
    rest = tokens.slice(3);
  } else if ((name === "cargo" || name === "go") && tokens[1] === "test") {
    runner = `${name} test`;
    rest = tokens.slice(2);
  } else if (NODE_TEST_RUNNERS.has(name) && tokens[1] === "test") {
    runner = `${name} test`;
    rest = tokens.slice(2);
  }
  if (runner === null) return null;

  // Same cwd resolution the shell tool applies at dispatch, so the key
  // matches the directory the command actually runs in.
  let cwd: string;
  try {
    cwd =
      typeof record.cwd === "string" && record.cwd.length > 0
        ? resolveUserPath(record.cwd, workingDir)
        : workingDir;
  } catch {
    return null;
  }

  // `timeoutMs` is deliberately absent: it controls execution, not test
  // selection, so timeout-only variation collapses to the same key. NUL
  // separators preserve argv boundaries (["-k","a b"] differs from
  // ["-k","a","b"]).
  return {
    key: [cwd, runner, ...rest].join("\u0000"),
    label: rest.length > 0 ? `${runner} ${rest.join(" ")}` : runner,
    cwd,
  };
}
