import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalCategory } from "../../approval/approval-level.js";
import { getConfig } from "../../config/index.js";

/**
 * Where a filesystem mutation lands, from the approval ladder's point
 * of view:
 *
 *  - `workspace` — strictly inside the session working directory.
 *  - `home` — inside the user's home directory (but not the workspace).
 *  - `outside` — anywhere else (system paths, other volumes, or paths
 *    we failed to canonicalise). Conservative bucket: maps to the
 *    `other` category, which asks on every level except 5.
 *
 * Containment is decided on canonical (realpath) forms, so a symlink
 * inside the workspace that points outside is classified by its target,
 * never by where the link lives. This holds for **dangling** symlinks
 * too: if the leaf is a symlink whose target does not exist yet, we
 * classify by the (resolved) link target rather than the parent — a
 * `writeFile` through such a link creates the file at the target, so
 * treating it as a workspace write would be a silent escape. See
 * `canonicalizeMutationTarget`.
 */
export type FsScope = "workspace" | "home" | "outside";

/** Closed set of fs mutations the ladder distinguishes. */
export type FsMutationKind = "write" | "trash" | "extract";

export interface FsScopeOptions {
  workingDir: string;
  /** Test seam; production call sites use the real home directory. */
  homeDir?: string;
  /**
   * Absolute paths that hold the agent's own trust configuration — the
   * user config file and the `.env` with API tokens. A write/edit/patch
   * whose realpath matches one of these is categorised `trust_config`
   * (asks until level 5) regardless of scope. Test seam; production
   * reads them from `getConfig()`.
   */
  trustConfigPaths?: readonly string[];
}

/**
 * Categorise a filesystem mutation for the approval gate.
 *
 *  - `write` (os.fs.write / edit / patch): `trust_config` when the
 *    target is the agent's own config / `.env` (asks until level 5),
 *    else `fs_write_workspace` inside the workspace (silent from level
 *    2), `fs_write_home` inside home (silent from level 3), `other`
 *    outside both.
 *  - `trash` (os.fs.trash): `trust_config` when a target is the
 *    config / `.env` (trashing the trust file is a trust mutation too),
 *    else `fs_trash` inside workspace or home (silent from level 3 —
 *    level 2 deliberately covers plain writes only), `other` outside.
 *  - `extract` (os.fs.archive.extract): `fs_write_home` inside
 *    workspace or home — the ladder admits extraction at level 3, not
 *    level 2, because an archive materialises content the operator has
 *    not reviewed line-by-line — `other` outside. (Extraction targets a
 *    directory, so the config-file guard does not apply.)
 *
 * Multiple paths combine to the weakest scope (any `outside` path makes
 * the whole call `outside`); a single `trust_config` target makes the
 * whole call `trust_config` since it is the strictest bucket.
 */
export async function categorizeFsMutation(
  kind: FsMutationKind,
  absolutePaths: readonly string[],
  options: FsScopeOptions,
): Promise<ApprovalCategory> {
  if (kind !== "extract") {
    const trustPaths = resolveTrustConfigPaths(options);
    if (await touchesTrustConfig(absolutePaths, trustPaths)) {
      return "trust_config";
    }
  }
  const scope = await resolveFsScope(absolutePaths, options);
  switch (kind) {
    case "write":
      if (scope === "workspace") return "fs_write_workspace";
      if (scope === "home") return "fs_write_home";
      return "other";
    case "trash":
      return scope === "outside" ? "other" : "fs_trash";
    case "extract":
      return scope === "outside" ? "other" : "fs_write_home";
  }
}

/** Combined scope of one or more absolute paths (weakest wins). */
export async function resolveFsScope(
  absolutePaths: readonly string[],
  options: FsScopeOptions,
): Promise<FsScope> {
  if (absolutePaths.length === 0) return "outside";
  const workspaceRoot = await canonicalizeExisting(options.workingDir);
  const homeRoot = await canonicalizeExisting(options.homeDir ?? homedir());
  let combined: FsScope = "workspace";
  for (const path of absolutePaths) {
    const scope = await scopeOfPath(path, workspaceRoot, homeRoot);
    if (scope === "outside") return "outside";
    if (scope === "home") combined = "home";
  }
  return combined;
}

async function scopeOfPath(
  path: string,
  workspaceRoot: string | null,
  homeRoot: string | null,
): Promise<FsScope> {
  const canonical = await canonicalizeMutationTarget(path);
  if (canonical === null) return "outside";
  if (workspaceRoot !== null && isContained(workspaceRoot, canonical)) {
    return "workspace";
  }
  if (homeRoot !== null && isContained(homeRoot, canonical)) {
    return "home";
  }
  return "outside";
}

/** Realpath a directory that must exist; `null` when it cannot be resolved. */
async function canonicalizeExisting(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Canonicalise the effective on-disk location a mutation would touch.
 *
 * `realpath` already follows symlinks for existing paths. The subtle
 * case is a **dangling** leaf symlink: `os.fs.write path/leak.txt` where
 * `leak.txt` is a symlink to a not-yet-existing file outside the
 * workspace. `realpath(leak.txt)` throws ENOENT, and naively stripping
 * the ENOENT leaf and re-attaching it to the parent would classify the
 * write as "inside the parent" — but `writeFile` follows the link and
 * creates the file at the target, escaping the workspace silently.
 *
 * So before falling back to the deepest-existing-ancestor logic, we
 * check whether the leaf itself is a symlink (`lstat`) even though it
 * failed to `realpath`. If it is, we resolve its target against the
 * link's directory and canonicalise **that** — recursively, so a chain
 * of dangling links is followed to where the write actually lands.
 * Non-symlink ENOENT leaves (a genuinely new file) keep the ancestor
 * behaviour: the missing suffix cannot contain symlinks because it does
 * not exist.
 */
async function canonicalizeMutationTarget(
  path: string,
  depth = 0,
): Promise<string | null> {
  // Bound symlink-chain following so a pathological cycle of dangling
  // links cannot loop forever.
  if (depth > 40) return null;
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  // The path (or something under it) does not exist. If the leaf is a
  // dangling symlink, follow it to its target — that is where a write
  // lands.
  const linkTarget = await readlinkIfSymlink(path);
  if (linkTarget !== null) {
    const resolvedTarget = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(path), linkTarget);
    return canonicalizeMutationTarget(resolvedTarget, depth + 1);
  }
  return canonicalizeDeepestExisting(path);
}

/** `readlink` when `path` is a symlink (even a broken one); else `null`. */
async function readlinkIfSymlink(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return null;
    return await readlink(path);
  } catch {
    return null;
  }
}

/**
 * Realpath the deepest existing ancestor of `path` and re-attach the
 * non-existing suffix. Only reached for a plain new file (leaf is not a
 * symlink). Returns `null` when even the filesystem root fails to
 * resolve (permission errors, dead mounts) — callers treat that as
 * `outside`.
 */
async function canonicalizeDeepestExisting(
  path: string,
): Promise<string | null> {
  let current = path;
  let suffix = "";
  // Bounded by path depth: every iteration strips one component.
  for (;;) {
    try {
      const resolved = await realpath(current);
      return suffix.length === 0 ? resolved : join(resolved, suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null; // hit the fs root, still ENOENT
      suffix = suffix.length === 0 ? basenameOf(current) : join(basenameOf(current), suffix);
      current = parent;
    }
  }
}

function basenameOf(path: string): string {
  return path.slice(dirname(path).length).replace(/^[\\/]+/, "");
}

/** Boundary-safe containment: `child` equals `parent` or lives under it. */
function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Production trust-config paths: the user config file and the `.env`
 * that sits next to it in the state directory. Both hold the agent's
 * own trust surface — `config.json` carries `agent.approvalLevel`, and
 * `.env` carries API keys / bot tokens the runtime loads at boot — so a
 * silent rewrite of either is an escalation vector. Overridable for
 * tests.
 */
function resolveTrustConfigPaths(options: FsScopeOptions): readonly string[] {
  if (options.trustConfigPaths !== undefined) return options.trustConfigPaths;
  const { userConfigFile, stateDir } = getConfig().paths;
  return [userConfigFile, join(stateDir, ".env")];
}

/**
 * True when any target path resolves to a trust-config file. Compared on
 * realpath (or the dangling-symlink target) so a symlink or a `..`
 * detour to `config.json` is caught, not just a literal string match.
 * The trust paths themselves are canonicalised, and a not-yet-existing
 * trust file (fresh install writing its first `.env`) still matches via
 * the deepest-existing-ancestor + suffix comparison.
 */
async function touchesTrustConfig(
  absolutePaths: readonly string[],
  trustPaths: readonly string[],
): Promise<boolean> {
  if (trustPaths.length === 0) return false;
  const canonicalTrust = await Promise.all(
    trustPaths.map((p) => canonicalizeMutationTarget(p)),
  );
  const trustSet = new Set(
    canonicalTrust.filter((p): p is string => p !== null),
  );
  if (trustSet.size === 0) return false;
  for (const path of absolutePaths) {
    const canonical = await canonicalizeMutationTarget(path);
    if (canonical !== null && trustSet.has(canonical)) return true;
  }
  return false;
}
