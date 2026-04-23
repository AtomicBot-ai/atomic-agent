import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENV_PATH = resolve(HERE, "..", ".env");

export interface LoadEvalEnvResult {
  loaded: boolean;
  path: string;
}

/**
 * Load `eval/.env` into `process.env` via Node's built-in loader.
 *
 * Called from the eval entry points (vitest spec + standalone judge
 * CLI) before any env-driven configuration is resolved. Idempotent:
 * calling twice is harmless but redundant.
 *
 * Existing `process.env` values are preserved — Node's `loadEnvFile`
 * does not overwrite variables already set in the shell, which is the
 * behaviour we want (CI secrets win over a local checked-in `.env`
 * example copy).
 *
 * Silent no-op when the file does not exist: this keeps fresh clones
 * working until the developer fills in the file.
 */
export function loadEvalEnvFile(): LoadEvalEnvResult {
  if (!existsSync(ENV_PATH)) return { loaded: false, path: ENV_PATH };
  process.loadEnvFile(ENV_PATH);
  return { loaded: true, path: ENV_PATH };
}
