import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ENV_FILE = resolve(HERE, "..", ".env");

/**
 * Load eval/.env into process.env using Node 22+'s native
 * `process.loadEnvFile`. Missing files are silently ignored so the
 * harness still runs when a caller exports vars directly (e.g. CI).
 *
 * We call this once from both entry points (vitest spec and
 * `eval:judge` CLI) before any config parsing so every downstream
 * `loadJudgeConfigFromEnv` / llama-url lookup sees the same view.
 */
export function loadEvalEnvFile(path = DEFAULT_ENV_FILE): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    process.stderr.write(
      `[eval] failed to load ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
