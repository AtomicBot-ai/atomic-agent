import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `.env` read failure that survived the retry loop (or was not
 * retryable). Carries the errno code and Node's error message, which
 * names the path but never the file content.
 */
export interface DotenvReadFailure {
  /** Node errno code (`"EPERM"`, `"EACCES"`, ...) or null when absent. */
  code: string | null;
  /** Node's error message. Includes the path, never file content. */
  message: string;
  /** How many read attempts were made before giving up. */
  attempts: number;
}

export interface DotenvLoadResult {
  /** Absolute path of the `.env` file we attempted to read. */
  path: string;
  /**
   * Whether the file was found and parsed. Stays `false` both when the
   * file is missing and when it exists but could not be read; `error`
   * distinguishes the two.
   */
  exists: boolean;
  /** Names of variables that were applied to `process.env`. Never values. */
  loaded: string[];
  /** Names of variables present in the file but already set in `process.env`. */
  skipped: string[];
  /**
   * Non-ENOENT read failure after retries. `null` when the file loaded
   * fine or does not exist. Frontends must surface this to the user:
   * a `.env` that exists but cannot be read means stored secrets were
   * silently dropped (#59).
   */
  error: DotenvReadFailure | null;
}

/** I/O seams, injectable for tests. Production callers omit them. */
export interface DotenvIoDeps {
  readFile: (path: string) => string;
  sleep: (ms: number) => void;
}

/**
 * Codes worth retrying: on Windows a file briefly locked by antivirus
 * or sync software (OneDrive, Dropbox) surfaces as EPERM/EBUSY, and
 * POSIX equivalents as EACCES/EAGAIN. ENOENT is never retried (missing
 * file is the silent no-op case) and everything else fails fast.
 */
const RETRYABLE_READ_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN"]);
const READ_ATTEMPTS = 3;
const READ_BACKOFF_MS: readonly number[] = [50, 150];

/**
 * Match a conventional env-var key: starts with an uppercase letter or an
 * underscore, followed by uppercase letters / digits / underscores. Lowercase
 * names and dashes are intentionally rejected — the loader only handles
 * canonical secrets, not arbitrary shell aliases.
 */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Blocking sleep for the synchronous config bootstrap path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Strip a single matching pair of surrounding quotes (`"..."` or `'...'`).
 * Inner content is taken verbatim — no escape sequences, no `${VAR}`
 * interpolation. Mismatched quotes are left as-is so the user sees their
 * literal value (and can debug from it).
 */
function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a single line into `[key, value]` or `null` when the line is a
 * comment / blank / malformed. Unknown formats are reported via `onError`
 * so the caller can warn once and keep going.
 */
function parseLine(
  line: string,
  onError: (reason: string) => void,
): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    onError(`missing '=': ${trimmed}`);
    return null;
  }

  const key = trimmed.slice(0, eq).trim();
  const rawValue = trimmed.slice(eq + 1).trim();

  if (!KEY_PATTERN.test(key)) {
    onError(`invalid key '${key}'`);
    return null;
  }

  return [key, stripQuotes(rawValue)];
}

/**
 * Read the file with a short retry loop. Windows antivirus and sync
 * clients hold transient locks that surface as EPERM/EBUSY for a few
 * milliseconds; two brief backoffs ride those out without noticeably
 * delaying startup (worst case ~200ms, only when the file exists and
 * is unreadable). Returns the raw text, `"missing"` for ENOENT, or the
 * failure that survived the loop.
 */
function readWithRetry(
  path: string,
  deps: DotenvIoDeps,
): { kind: "ok"; raw: string } | { kind: "missing" } | { kind: "failed"; failure: DotenvReadFailure } {
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      return { kind: "ok", raw: deps.readFile(path) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? null;
      if (code === "ENOENT") return { kind: "missing" };
      const message = err instanceof Error ? err.message : String(err);
      const failure: DotenvReadFailure = { code, message, attempts: attempt };
      if (!code || !RETRYABLE_READ_CODES.has(code)) {
        return { kind: "failed", failure };
      }
      if (attempt === READ_ATTEMPTS) {
        return { kind: "failed", failure };
      }
      deps.sleep(READ_BACKOFF_MS[attempt - 1] ?? READ_BACKOFF_MS[READ_BACKOFF_MS.length - 1] ?? 50);
    }
  }
  // Unreachable: the loop always returns. Keeps tsc's control-flow happy.
  return { kind: "missing" };
}

/**
 * Human-readable warning for a `.env` that exists but could not be read.
 * Shown in the TUI chat and on stderr — must carry the path, the errno
 * code, and actionable platform-specific guidance, and must never carry
 * file content. `platform` is injectable for tests.
 */
export function formatDotenvReadWarning(
  path: string,
  failure: DotenvReadFailure,
  platform: NodeJS.Platform = process.platform,
): string {
  const attempts = failure.attempts === 1 ? "1 attempt" : `${failure.attempts} attempts`;
  const code = failure.code ?? "unknown error";
  const fix =
    platform === "win32"
      ? `Fix: clear the file's read-only attribute (right-click the file, Properties), add an antivirus exclusion for the folder, or reset its permissions: icacls "${path}" /reset`
      : `Fix: check the file's owner and permissions (ls -l "${path}"), then chmod 600 "${path}" as the user that runs atomic-agent.`;
  return [
    `Could not read secrets file: ${path} (${code} after ${attempts}).`,
    "Saved API keys and tokens from .env were NOT loaded this run.",
    fix,
  ].join("\n");
}

/**
 * Read `<stateDir>/.env` and merge its variables into `process.env`. Existing
 * `process.env` entries always win — shell-exported values take priority
 * over the file. A missing file is a silent no-op (the common case for
 * users who do not need any secrets). A file that exists but cannot be
 * read is retried briefly and then reported both on stderr and in
 * `result.error` so frontends can warn loudly instead of silently
 * starting without secrets (#59).
 *
 * The loader has no external dependency and supports a deliberately tiny
 * subset of dotenv syntax: `KEY=VALUE` per line, optional surrounding
 * quotes, `#` line comments, blank lines. No interpolation, no `export`
 * prefix, no multiline values. Add later if a real use case demands it.
 *
 * Returned `loaded` / `skipped` lists carry variable **names only** — values
 * never reach traces or logs through this surface.
 */
export function loadDotenvFromStateDir(
  stateDir: string,
  deps: Partial<DotenvIoDeps> = {},
): DotenvLoadResult {
  const io: DotenvIoDeps = {
    readFile: deps.readFile ?? ((p) => readFileSync(p, "utf8")),
    sleep: deps.sleep ?? sleepSync,
  };
  const path = join(stateDir, ".env");
  const result: DotenvLoadResult = {
    path,
    exists: false,
    loaded: [],
    skipped: [],
    error: null,
  };

  const read = readWithRetry(path, io);
  if (read.kind === "missing") return result;
  if (read.kind === "failed") {
    result.error = read.failure;
    process.stderr.write(
      `atomic-agent: ${formatDotenvReadWarning(path, read.failure)}\n`,
    );
    return result;
  }

  result.exists = true;

  for (const line of read.raw.split(/\r?\n/)) {
    const parsed = parseLine(line, (reason) => {
      process.stderr.write(`atomic-agent: skipping ${path} entry — ${reason}\n`);
    });
    if (parsed === null) continue;

    const [key, value] = parsed;
    const existing = process.env[key];
    if (existing !== undefined && existing.length > 0) {
      result.skipped.push(key);
      continue;
    }

    process.env[key] = value;
    result.loaded.push(key);
  }

  return result;
}
