import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ENV_FILE = resolve(HERE, "..", ".env");

/**
 * Load `eval-memory/.env` into process.env. Mirrors `eval/harness/load-env-file.ts`
 * so the two harnesses behave consistently for the operator. Shell-exported
 * vars always win (CI-friendly).
 */
export function loadMemoryEvalEnvFile(path = DEFAULT_ENV_FILE): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    process.stderr.write(
      `[eval-memory] failed to load ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
