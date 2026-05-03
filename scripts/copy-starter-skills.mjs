/**
 * Copies repo-root starter-skills/ next to compiled output so runtime can
 * resolve dist/starter-skills from dist/skills/*.js via import.meta.url.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const src = join(root, "starter-skills");
const dest = join(root, "dist", "starter-skills");

if (!existsSync(src)) {
  process.stderr.write(`warning: ${src} missing; skip copy-starter-skills\n`);
  process.exit(0);
}

cpSync(src, dest, { recursive: true });
process.stdout.write(`copied starter-skills → ${dest}\n`);
