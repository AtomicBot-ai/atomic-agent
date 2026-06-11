import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENV_FILE = resolve(HERE, "..", ".env");

export function loadEvalAgentsEnvFile(): void {
  if (!existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.error(
      `[eval-agents] failed to load ${ENV_FILE}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
