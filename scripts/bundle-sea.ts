/**
 * Bundle the CLI into a single ESM file for Node SEA embedding.
 * Transitive `dist/**` and `node_modules` are not shipped next to the
 * published binary; only this file is embedded in the SEA blob.
 * `sea-config.json` must set `mainFormat: "module"` so Node treats the
 * injected script as ESM. A top-of-file banner exposes `require` via
 * `createRequire` for dependencies that still use dynamic `require()`.
 */
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { exit, stderr, stdout } from "node:process";
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "dist-sea");
const OUT_FILE = join(OUT_DIR, "cli.mjs");
const ENTRY = join(ROOT, "src", "cli", "index.ts");

async function main(): Promise<number> {
  await mkdir(OUT_DIR, { recursive: true });

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // Linked maps are not embedded in SEA; keep output smaller so startup parse uses less RAM.
    sourcemap: false,
    minify: true,
    // Preserve some names for less cryptic error stacks; identifiers still mangle.
    keepNames: true,
    legalComments: "none",
    jsx: "automatic",
    jsxImportSource: "react",
    mainFields: ["module", "main"],
    external: ["better-sqlite3"],
    loader: { ".node": "file" },
    // CJS dependencies use `require("events")`, `__dirname`, and `__filename`. The ESM output must
    // polyfill all three: `createRequire(import.meta.url)` for `require`, and
    // `fileURLToPath(import.meta.url)` + `path.dirname(...)` for the two CJS path globals. Without the
    // dir/file polyfill bundled CJS deps (e.g. playwright-core, chromium-bidi) throw
    // `ReferenceError: __dirname is not defined` at first use.
    banner: {
      js: `import { createRequire as __createRequireForSea } from "node:module";
import { fileURLToPath as __fileURLToPathForSea } from "node:url";
import { dirname as __dirnameForSea } from "node:path";
const require = __createRequireForSea(import.meta.url);
const __filename = __fileURLToPathForSea(import.meta.url);
const __dirname = __dirnameForSea(__filename);
`,
    },
    logLevel: "warning",
  });

  const st = await stat(OUT_FILE);
  stdout.write(`bundle-sea: wrote ${OUT_FILE} (${st.size} bytes)\n`);
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    stderr.write(`${message}\n`);
    exit(1);
  });
