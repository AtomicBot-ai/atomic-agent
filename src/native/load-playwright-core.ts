/**
 * Lazy loader for `playwright-core` that works both in development and inside
 * a Node SEA binary built with `"mainFormat": "module"`.
 *
 * `playwright-core` performs a number of `require.resolve(...)` calls at
 * module-load time (see `lib/server/utils/userAgent.js` →
 * `nodePlatform.coreDir`, `boxedStackPrefixes`, etc.), which esbuild cannot
 * statically inline into string literals. When the package is bundled into
 * the SEA blob those calls execute against `import.meta.url` — i.e. the SEA
 * binary itself — and immediately fail with
 * `Cannot find module '../../../package.json'` because the relative path
 * has nothing to anchor on.
 *
 * Mirroring the `better-sqlite3` pattern, we mark `playwright-core` as
 * external in `scripts/bundle-sea.ts` and ship a real `node_modules/
 * playwright-core` tree alongside the SEA binary. At runtime this loader
 * routes the load through CJS `createRequire` anchored at the executable's
 * directory, so Node's normal module resolution finds the on-disk package
 * and Playwright's internal `require.resolve(...)` calls succeed against
 * the actual files.
 *
 * In development (running via `tsx` / `npm test`) we fall back to a normal
 * dynamic `import("playwright-core")`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import type * as PlaywrightCore from "playwright-core";

type PwModule = typeof PlaywrightCore;

const bootRequire = createRequire(import.meta.url);

function isRunningUnderSea(): boolean {
  try {
    const sea: typeof import("node:sea") = bootRequire("node:sea");
    return sea.isSea();
  } catch {
    return false;
  }
}

let cached: PwModule | null = null;

export async function loadPlaywrightCore(): Promise<PwModule> {
  if (cached) return cached;
  if (isRunningUnderSea()) {
    const anchor = join(dirname(execPath), "__atomic_sea_anchor__.js");
    const req = createRequire(anchor);
    cached = req("playwright-core") as PwModule;
    return cached;
  }
  const mod = (await import("playwright-core")) as unknown as PwModule;
  cached = mod;
  return cached;
}
