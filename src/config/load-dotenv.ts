import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DotenvLoadResult {
  /** Absolute path of the `.env` file we attempted to read. */
  path: string;
  /** Whether the file was found and parsed. */
  exists: boolean;
  /** Names of variables that were applied to `process.env`. Never values. */
  loaded: string[];
  /** Names of variables present in the file but already set in `process.env`. */
  skipped: string[];
}

/**
 * Match a conventional env-var key: starts with an uppercase letter or an
 * underscore, followed by uppercase letters / digits / underscores. Lowercase
 * names and dashes are intentionally rejected — the loader only handles
 * canonical secrets, not arbitrary shell aliases.
 */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

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
 * Read `<stateDir>/.env` and merge its variables into `process.env`. Existing
 * `process.env` entries always win — shell-exported values take priority
 * over the file. A missing file is a silent no-op (the common case for
 * users who do not need any secrets).
 *
 * The loader has no external dependency and supports a deliberately tiny
 * subset of dotenv syntax: `KEY=VALUE` per line, optional surrounding
 * quotes, `#` line comments, blank lines. No interpolation, no `export`
 * prefix, no multiline values. Add later if a real use case demands it.
 *
 * Returned `loaded` / `skipped` lists carry variable **names only** — values
 * never reach traces or logs through this surface.
 */
export function loadDotenvFromStateDir(stateDir: string): DotenvLoadResult {
  const path = join(stateDir, ".env");
  const result: DotenvLoadResult = {
    path,
    exists: false,
    loaded: [],
    skipped: [],
  };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return result;
    }
    process.stderr.write(
      `atomic-agent: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return result;
  }

  result.exists = true;

  for (const line of raw.split(/\r?\n/)) {
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
