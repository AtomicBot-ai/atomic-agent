import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  ConfigValidationError,
  ENV_DEFAULTS,
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  type UserConfigFile,
} from "./config-schema.js";

/** Resolve the absolute path to the user config file inside a state dir. */
export function getUserConfigPath(stateDir: string): string {
  return join(stateDir, ENV_DEFAULTS.USER_CONFIG_FILE_NAME);
}

/**
 * Synchronously read and validate the user config file.
 * Returns `null` if the file does not exist. Throws `ConfigValidationError`
 * if the file is present but malformed.
 *
 * Pure read — does not migrate the file on disk. Use
 * `ensureUserConfigFileSync` from the bootstrap path to get the
 * active-migration behaviour.
 */
export function readUserConfigFileSync(path: string): UserConfigFile | null {
  const raw = readRawUserConfigFileSync(path);
  if (!raw) return null;
  return parseUserConfigFile(raw.parsed);
}

/**
 * Atomically write the user config file: tmp file + rename. Creates
 * the parent directory as needed.
 */
export function writeUserConfigFileSync(path: string, data: UserConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

/**
 * Ensure the user config file exists and is at the current schema
 * version.
 *
 *  - File missing: write defaults, warn once on stderr, return defaults.
 *  - File present at older `version`: parse (which fills in defaults
 *    for any added blocks transparently), atomically rewrite the file
 *    in v{USER_CONFIG_VERSION} shape, and log one migration line to
 *    stderr for auditability. Existing user values are preserved
 *    verbatim — only the `version` field bumps and any newly added
 *    blocks (e.g. `vision` in v6) are filled with defaults.
 *  - File present at the current `version`: parse and return without
 *    touching the file on disk.
 *
 * The return value is always the validated, normalised contents.
 */
export function ensureUserConfigFileSync(path: string): UserConfigFile {
  const raw = readRawUserConfigFileSync(path);
  if (!raw) {
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    process.stderr.write(
      `[atomic-agent] created default config at ${path}\n`,
    );
    return USER_CONFIG_DEFAULTS;
  }
  const parsed = parseUserConfigFile(raw.parsed);
  if (raw.originalVersion !== USER_CONFIG_VERSION) {
    writeUserConfigFileSync(path, parsed);
    process.stderr.write(
      `[atomic-agent] migrated config v${raw.originalVersion} → v${USER_CONFIG_VERSION} at ${path}\n`,
    );
  }
  return parsed;
}

interface RawUserConfigFile {
  /** Untouched parsed JSON tree, ready for `parseUserConfigFile`. */
  parsed: unknown;
  /** Pre-migration `version` field straight from disk, or `null` when missing/malformed. */
  originalVersion: number | null;
}

function readRawUserConfigFileSync(path: string): RawUserConfigFile | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigValidationError(
      "<file>",
      `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigValidationError(
      "<file>",
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { parsed, originalVersion: readVersionField(parsed) };
}

function readVersionField(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).version;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
