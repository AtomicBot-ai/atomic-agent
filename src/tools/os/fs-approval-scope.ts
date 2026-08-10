import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ApprovalCategory } from "../../approval/approval-level.js";

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
 * never by where the link lives. For a path that does not exist yet
 * (`os.fs.write` creating a file) the deepest existing ancestor is
 * canonicalised and the non-existing suffix re-attached — the suffix
 * cannot contain symlinks because it does not exist.
 */
export type FsScope = "workspace" | "home" | "outside";

/** Closed set of fs mutations the ladder distinguishes. */
export type FsMutationKind = "write" | "trash" | "extract";

export interface FsScopeOptions {
  workingDir: string;
  /** Test seam; production call sites use the real home directory. */
  homeDir?: string;
}

/**
 * Categorise a filesystem mutation for the approval gate.
 *
 *  - `write` (os.fs.write / edit / patch): `fs_write_workspace` inside
 *    the workspace (silent from level 2), `fs_write_home` inside home
 *    (silent from level 3), `other` outside both.
 *  - `trash` (os.fs.trash): `fs_trash` inside workspace or home (silent
 *    from level 3 — level 2 deliberately covers plain writes only),
 *    `other` outside.
 *  - `extract` (os.fs.archive.extract): `fs_write_home` inside
 *    workspace or home — the ladder admits extraction at level 3, not
 *    level 2, because an archive materialises content the operator has
 *    not reviewed line-by-line — `other` outside.
 *
 * Multiple paths combine to the weakest scope (any `outside` path makes
 * the whole call `outside`).
 */
export async function categorizeFsMutation(
  kind: FsMutationKind,
  absolutePaths: readonly string[],
  options: FsScopeOptions,
): Promise<ApprovalCategory> {
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
  const canonical = await canonicalizeDeepestExisting(path);
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
 * Realpath the deepest existing ancestor of `path` and re-attach the
 * non-existing suffix. Returns `null` when even the filesystem root
 * fails to resolve (permission errors, dead mounts) — callers treat
 * that as `outside`.
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
