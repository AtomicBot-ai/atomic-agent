/**
 * Bundle the CLI into a single ESM file for Node SEA embedding.
 * Transitive `dist/**` and `node_modules` are not shipped next to the
 * published binary; only this file is embedded in the SEA blob.
 * `sea-config.json` must set `mainFormat: "module"` so Node treats the
 * injected script as ESM. A top-of-file banner exposes `require` via
 * `createRequire` for dependencies that still use dynamic `require()`.
 *
 * When `SENTRY_AUTH_TOKEN` is present (release CI only), the bundle's
 * sourcemap is uploaded to Sentry via `@sentry/esbuild-plugin` and then
 * deleted from disk — the shipped binary never carries a `.map` file or
 * a `sourceMappingURL` comment, but Sentry can still symbolicate stack
 * traces for the exact release version. See `src/error-reporting/` for
 * the privacy-scrubbing rules applied to the events themselves.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { exit, stderr, stdout } from "node:process";
import * as esbuild from "esbuild";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "dist-sea");
const OUT_FILE = join(OUT_DIR, "cli.mjs");
const ENTRY = join(ROOT, "src", "cli", "index.ts");

// Must match the org/project slugs the runtime's Sentry DSN posts events
// to (see `src/error-reporting/sentry-config.ts`), and the release name
// must match `getAppVersion()` (see `src/version.ts`) so a symbolicated
// stack trace resolves against the exact build that produced it.
const SENTRY_ORG = "atomic-agent";
const SENTRY_PROJECT = "cli";

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
  // Only set in CI on the repo that owns the release (forked-PR / local dev
  // runs never see this secret) — gates the Sentry upload below so a plain
  // `npm run bundle:sea` never needs credentials or talks to Sentry.
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // "external" writes a sibling `cli.mjs.map` without a trailing
    // `//# sourceMappingURL=` comment in the shipped bundle — the map never
    // ships (see `sourcemaps.filesToDeleteAfterUpload` below; `package-bundle.ts`
    // also never globs `dist-sea/*.map`), it only exists long enough for the
    // Sentry plugin to read and upload it for stack-trace symbolication.
    sourcemap: "external",
    minify: true,
    // Preserve some names for less cryptic error stacks; identifiers still mangle.
    keepNames: true,
    legalComments: "none",
    jsx: "automatic",
    jsxImportSource: "react",
    mainFields: ["module", "main"],
    // `playwright-core` performs `require.resolve(...)` calls at module load
    // (e.g. `lib/server/utils/userAgent.js → coreDir`) that esbuild cannot
    // statically inline. Bundling them produces a SEA binary that fails with
    // `Cannot find module '../../../package.json'` the first time a browser
    // tool runs. Externalise the package and ship its `node_modules/` tree
    // next to the binary (see `scripts/package-bundle.ts`).
    external: ["better-sqlite3", "playwright-core"],
    // Bake the published version into the binary so `getAppVersion()`
    // (see src/version.ts) resolves without a shipped package.json.
    define: {
      __ATOMIC_AGENT_VERSION__: JSON.stringify(version),
      // React ships as two builds behind a runtime
      // `process.env.NODE_ENV === "production" ? prod : dev` switch. A
      // SEA has no build-time env, so without this define BOTH builds
      // land in the bundle and the *development* reconciler is what
      // actually runs on any machine whose shell does not export
      // NODE_ENV — which is every machine.
      //
      // That is not merely slow. React 19's development build carries
      // the Component Performance Track, which calls
      // `performance.measure()` for every component render; Node keeps
      // every user-timing entry alive for the life of the process. The
      // TUI redraws on a timer even while idle (~114 measures/s), so an
      // open session grew the heap without bound and aborted with
      // `FATAL ERROR: JavaScript heap out of memory` after six to seven
      // hours — twice, on the same laptop, before anyone connected the
      // crash to a missing define.
      //
      // Inlining the constant also lets esbuild drop the dev build as
      // dead code, so the binary gets smaller as a side effect.
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    loader: { ".node": "file" },
    plugins: sentryAuthToken
      ? [
          sentryEsbuildPlugin({
            org: SENTRY_ORG,
            project: SENTRY_PROJECT,
            authToken: sentryAuthToken,
            telemetry: false,
            release: { name: version },
            sourcemaps: {
              // Delete the map from disk right after Sentry has it — belt-and-
              // suspenders on top of `package-bundle.ts` never globbing it.
              filesToDeleteAfterUpload: [join(OUT_DIR, "*.map")],
            },
            // Sourcemap upload is best-effort observability, never a release
            // gate: log and let the build continue on any failure (auth,
            // network, Sentry outage, ...).
            errorHandler: (err) => {
              stderr.write(
                `bundle-sea: sentry sourcemap upload failed (continuing build): ${err.message}\n`,
              );
            },
          }),
        ]
      : [],
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
  stdout.write(
    `bundle-sea: wrote ${OUT_FILE} (${st.size} bytes, version ${version})\n`,
  );
  stdout.write(
    sentryAuthToken
      ? `bundle-sea: uploaded sourcemap to Sentry (org=${SENTRY_ORG} project=${SENTRY_PROJECT} release=${version})\n`
      : "bundle-sea: SENTRY_AUTH_TOKEN not set; skipping sourcemap upload\n",
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
