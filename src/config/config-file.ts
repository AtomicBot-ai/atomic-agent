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
 */
export function readUserConfigFileSync(path: string): UserConfigFile | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigValidationError(
      "<file>",
      `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError(
      "<file>",
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseUserConfigFile(parsed);
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
 * Ensure the user config file exists. If it does not, write defaults
 * and emit a one-line warning to stderr so first-run users know where
 * the file lives. Always returns the validated current contents.
 */
export function ensureUserConfigFileSync(path: string): UserConfigFile {
  const existing = readUserConfigFileSync(path);
  if (existing) return existing;
  writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
  process.stderr.write(
    `[atomic-agent] created default config at ${path}\n`,
  );
  return USER_CONFIG_DEFAULTS;
}
