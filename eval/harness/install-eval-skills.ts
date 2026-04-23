import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(HERE, "..", "fixtures", "skills");

/**
 * Copy every skill from `eval/fixtures/skills/` into the per-case
 * `<stateDir>/skills/`. The runtime discovers them on bootstrap; no
 * `atomic-agent skill install` round-trip needed.
 *
 * No-op when `fixtures/skills/` is empty so OS-only cases incur zero
 * setup cost.
 */
export function installEvalSkills(stateDir: string): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  const targetDir = join(stateDir, "skills");
  mkdirSync(targetDir, { recursive: true });
  const installed: string[] = [];
  for (const entry of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(FIXTURES_DIR, entry.name);
    const dest = join(targetDir, entry.name);
    cpSync(src, dest, { recursive: true });
    installed.push(entry.name);
  }
  return installed;
}
