import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "renderer");
const to = join(here, "..", "out", "renderer");
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`renderer → ${to}`);
