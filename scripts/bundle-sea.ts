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
    sourcemap: true,
    minify: false,
    legalComments: "inline",
    jsx: "automatic",
    jsxImportSource: "react",
    mainFields: ["module", "main"],
    external: ["better-sqlite3"],
    loader: { ".node": "file" },
    // CJS dependencies use `require("events")` etc. The ESM output must expose `require` via createRequire.
    banner: {
      js: `import { createRequire as __createRequireForSea } from "node:module";
const require = __createRequireForSea(import.meta.url);
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
