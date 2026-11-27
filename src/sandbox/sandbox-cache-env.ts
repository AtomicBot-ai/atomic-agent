/**
 * Package caches for a command inside the OS sandbox (ATO-1651).
 *
 * The shared caches in the home folder (`~/.npm`, `~/.m2/repository`,
 * `~/.cargo/registry`, `~/go/pkg/mod`, `~/.gradle/caches`, pip, yarn,
 * pnpm, bun, Go's build cache, node-gyp headers, ...) are read later by
 * the user's own builds outside the sandbox, which trust what is there:
 * `npx foo` runs `~/.npm/_npx/<hash>` as is, Maven and Gradle load jars
 * from their caches, cargo and Go build sources already extracted to
 * theirs. A sandboxed command that could write them could plant code
 * that runs later with every right the user has. So none of them is
 * writable inside the sandbox; instead every known cache variable points
 * the tools at a private cache under temp, which only sandboxed commands
 * use. `npm install`, `npx`, `pip install`, `go build`, `cargo build`,
 * `mvn` and `gradle` keep working (from a cold cache, so they need the
 * sandbox network for new packages).
 *
 * Same rule as Codex CLI's `workspace-write` Seatbelt profile and Claude
 * Code's sandbox: writes only in the working folder and temp, no shared
 * caches by default.
 */
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SANDBOX_CACHE_DIR_NAME = "atomic-agent-sandbox-cache";

/**
 * The cache folder variables set inside the sandbox, each to its own
 * sub-folder of the sandbox cache. npm's covers `_cacache`, `_npx` and
 * `_logs`; the `npm_config_*` ones are read by pnpm and node-gyp too.
 * `CARGO_HOME` and `GRADLE_USER_HOME` are whole tool homes (there is no
 * cache-only variable), so the user's `~/.cargo/config.toml` and
 * `~/.gradle/gradle.properties` are not used inside the sandbox.
 */
export const SANDBOX_CACHE_VARS: Readonly<Record<string, string>> = {
  npm_config_cache: "npm",
  npm_config_devdir: "node-gyp",
  npm_config_store_dir: "pnpm-store",
  npm_config_cache_dir: "pnpm-cache",
  YARN_CACHE_FOLDER: "yarn",
  YARN_GLOBAL_FOLDER: "yarn-berry",
  BUN_INSTALL_CACHE_DIR: "bun",
  PIP_CACHE_DIR: "pip",
  UV_CACHE_DIR: "uv",
  GOMODCACHE: "go-mod",
  GOCACHE: "go-build",
  CARGO_HOME: "cargo",
  GRADLE_USER_HOME: "gradle",
  XDG_CACHE_HOME: "xdg",
};

/**
 * `env` with every cache variable pointed into `root`. A spelling of the
 * same name in another case (`NPM_CONFIG_CACHE`) is dropped first, so the
 * user's own value cannot win. Maven has no cache variable: its local
 * repository goes through `MAVEN_OPTS`, appended last so it wins over an
 * earlier `-Dmaven.repo.local`.
 */
export function withSandboxCacheEnv(
  env: Record<string, string | undefined>,
  root: string,
): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [name, sub] of Object.entries(SANDBOX_CACHE_VARS)) {
    set[name] = join(root, sub);
  }
  const mavenRepo = `-Dmaven.repo.local=${join(root, "m2")}`;
  const mavenOpts = Object.entries(env).find(([name]) => name.toUpperCase() === "MAVEN_OPTS")?.[1];
  set.MAVEN_OPTS =
    mavenOpts === undefined || mavenOpts.trim() === "" ? mavenRepo : `${mavenOpts} ${mavenRepo}`;
  const replaced = new Set(Object.keys(set).map((name) => name.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || replaced.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return { ...out, ...set };
}

function ownedPrivateFolder(dir: string, uid: number | null): boolean {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (uid !== null && st.uid !== uid) return false;
    // Nobody else may write into it (another local user planting a
    // package for the next sandboxed install).
    return (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * The sandbox cache folder under temp (inside the sandbox's writable
 * temp root), created private to this user. Kept across commands and
 * sessions so installs stay fast. A folder of that name that someone
 * else owns, or that is a link or writable by others, is never used: a
 * fresh private folder is made instead. Null only when temp itself
 * cannot be written; then the tools find their caches read-only.
 */
export function ensureSandboxCacheRoot(tmp: string = tmpdir()): string | null {
  let base: string;
  try {
    base = realpathSync(tmp);
  } catch {
    base = tmp;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const dir = join(base, uid === null ? SANDBOX_CACHE_DIR_NAME : `${SANDBOX_CACHE_DIR_NAME}-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    // Already there (checked below), or temp is not writable.
  }
  if (ownedPrivateFolder(dir, uid)) return dir;
  try {
    return mkdtempSync(join(base, `${SANDBOX_CACHE_DIR_NAME}-`));
  } catch {
    return null;
  }
}
