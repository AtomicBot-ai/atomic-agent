import { statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Runtime resolver for the `rg` (ripgrep) binary used by `os.fs.grep`.
 *
 * Lookup order:
 *   1. `process.env.ATOMIC_AGENT_RG_PATH` — explicit override (tests, CI,
 *      exotic layouts).
 *   2. `<dirname(process.execPath)>/vendor/rg[.exe]` — the sidecar file we
 *      ship alongside the SEA bundle.
 *   3. `<cwd>/node_modules/@vscode/ripgrep/bin/rg[.exe]` — automatic dev
 *      mode when the optional `@vscode/ripgrep` dev dependency is installed.
 *   4. Plain `rg` / `rg.exe` resolved via `$PATH`.
 *
 * Results are memoised for the process lifetime. Call `resetRipgrepCache()`
 * from tests to force re-resolution after mutating `process.env.PATH` or
 * `ATOMIC_AGENT_RG_PATH`.
 */

export interface RipgrepResolverOptions {
  /** Override `process.execPath` (tests). */
  execPath?: string;
  /** Override `process.cwd()` (tests). */
  cwd?: string;
  /** Override `process.env` (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the platform (tests). */
  platform?: NodeJS.Platform;
  /** Override fs existence check (tests). */
  fileExists?: (path: string) => boolean;
}

let cached: string | null | undefined;

export function resolveRipgrepPath(
  options: RipgrepResolverOptions = {},
): string | null {
  if (Object.keys(options).length === 0 && cached !== undefined) {
    return cached;
  }
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? defaultFileExists;

  const binaryName = platform === "win32" ? "rg.exe" : "rg";

  const override = env.ATOMIC_AGENT_RG_PATH;
  if (typeof override === "string" && override.length > 0) {
    if (fileExists(override)) {
      const result = override;
      if (Object.keys(options).length === 0) cached = result;
      return result;
    }
  }

  const bundled = join(dirname(execPath), "vendor", binaryName);
  if (fileExists(bundled)) {
    if (Object.keys(options).length === 0) cached = bundled;
    return bundled;
  }

  const devModule = join(
    cwd,
    "node_modules",
    "@vscode",
    "ripgrep",
    "bin",
    binaryName,
  );
  if (fileExists(devModule)) {
    if (Object.keys(options).length === 0) cached = devModule;
    return devModule;
  }

  const fromPath = lookupOnPath(binaryName, env, platform, fileExists);
  if (fromPath) {
    if (Object.keys(options).length === 0) cached = fromPath;
    return fromPath;
  }

  if (Object.keys(options).length === 0) cached = null;
  return null;
}

export function resetRipgrepCache(): void {
  cached = undefined;
}

function defaultFileExists(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function lookupOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathVar.length === 0) return null;
  const segments = pathVar.split(delimiter);
  const candidates =
    platform === "win32" ? [binaryName, "rg.exe", "rg.cmd", "rg.bat"] : [binaryName];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    for (const name of candidates) {
      const full = join(segment, name);
      if (fileExists(full)) return full;
    }
  }
  return null;
}

export const RIPGREP_MISSING_HINT =
  "ripgrep (`rg`) was not found. Install it via `brew install ripgrep`, `apt install ripgrep`, or `choco install ripgrep`, or set ATOMIC_AGENT_RG_PATH to a binary path.";
