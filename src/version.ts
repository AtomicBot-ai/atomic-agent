import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build-time-injected version literal. `scripts/bundle-sea.ts` passes
 * an esbuild `define` so the SEA binary carries the published version
 * even though `package.json` is not shipped next to it. In the dev /
 * npm-dist path the identifier is undeclared at runtime — the `typeof`
 * guard in `getAppVersion` falls back to reading `package.json`.
 */
declare const __ATOMIC_AGENT_VERSION__: string | undefined;

const FALLBACK_VERSION = "0.0.0-dev";

let cached: string | null = null;

/**
 * Resolve the running atomic-agent version. Prefers the build-time
 * constant (SEA binary), falling back to the package manifest for
 * `node dist/...` and `tsx src/...` invocations. Never throws — an
 * unreadable manifest degrades to {@link FALLBACK_VERSION}.
 */
export function getAppVersion(): string {
  if (cached !== null) return cached;
  // `typeof` on an undeclared identifier is safe (returns "undefined")
  // in the dist/dev path where esbuild did not substitute the literal.
  if (typeof __ATOMIC_AGENT_VERSION__ === "string") {
    cached = __ATOMIC_AGENT_VERSION__;
    return cached;
  }
  cached = readVersionFromManifest() ?? FALLBACK_VERSION;
  return cached;
}

function readVersionFromManifest(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js → ../package.json; src/version.ts → ../package.json.
    const manifestPath = resolve(here, "..", "package.json");
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}
