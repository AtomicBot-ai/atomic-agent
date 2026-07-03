/**
 * Bundle the sidecar entry (`src/sidecar/main.ts`) into a single ESM file for
 * Node SEA embedding — the Tauri-host counterpart of `bundle-sea.ts` (which
 * bundles the CLI). Only this file is embedded in the SEA blob;
 * `sea-config-sidecar.json` sets `mainFormat: "module"` so Node treats the
 * injected script as ESM.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { exit, stderr, stdout } from "node:process";
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "dist-sea");
const OUT_FILE = join(OUT_DIR, "sidecar.mjs");
const ENTRY = join(ROOT, "src", "sidecar", "main.ts");

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(join(ROOT, "package.json"), "utf-8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json is missing a string `version` field");
  }
  return parsed.version;
}

async function main(): Promise<number> {
  await mkdir(OUT_DIR, { recursive: true });

  const version = await readPackageVersion();

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    minify: true,
    keepNames: true,
    legalComments: "none",
    jsx: "automatic",
    jsxImportSource: "react",
    mainFields: ["module", "main"],
    // Same externals as the CLI bundle: `require.resolve` at module load for
    // playwright-core, and the native `better-sqlite3` addon. Their
    // `node_modules/` trees ship next to the binary (see package-bundle.ts).
    external: ["better-sqlite3", "playwright-core"],
    define: {
      __ATOMIC_AGENT_VERSION__: JSON.stringify(version),
    },
    loader: { ".node": "file" },
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
  stdout.write(
    `bundle-sidecar-sea: wrote ${OUT_FILE} (${st.size} bytes, version ${version})\n`,
  );
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    stderr.write(`${message}\n`);
    exit(1);
  });
