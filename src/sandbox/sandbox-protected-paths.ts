/**
 * Paths a sandboxed command may not write even inside its working folder
 * (ATO-2471). The working folder is writable, but some files in it run
 * code later, outside the sandbox: a git hook on the user's next commit,
 * `core.hooksPath` or `core.fsmonitor` in `.git/config`, a shell rc file
 * in a dotfiles repo linked into the home folder, `.envrc` on the next
 * `cd` with direnv, a VS Code task or a JetBrains run configuration on
 * the next open. Same class as the package-cache escape of ATO-1651.
 *
 * Same list as Claude Code's sandbox-runtime mandatory deny paths (shell
 * rc files, `.gitconfig`, `.gitmodules`, `.git/hooks`, `.git/config`,
 * `.vscode`, `.idea`), plus `.envrc` and fish's config; Codex keeps
 * `.git` read-only in its `workspace-write` profile.
 *
 * - macOS: fixed Seatbelt regexes, at any depth (no outside text goes
 *   into the profile). Seatbelt matches resolved paths, so a link to a
 *   hook does not get around it. `.git` itself cannot be created,
 *   renamed or replaced, so a hook cannot be planted in a fresh `.git`
 *   or in a copy renamed into place.
 * - Linux: bwrap has no patterns, so the working folders are searched
 *   (depth 3, as Claude Code does) and each protected path that exists
 *   is bound back read-only; a `.git` without a `hooks` folder is bound
 *   read-only whole, and the folders above each one are made mount
 *   points so they cannot be renamed away. A protected path that does not exist yet is not
 *   covered on Linux (bwrap would have to create it on the user's disk
 *   as a mount point).
 */
import { existsSync, lstatSync, readdirSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** Protected file names, wherever they are. */
export const PROTECTED_FILE_NAMES: readonly string[] = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".envrc",
  ".gitconfig",
  ".gitmodules",
];

/** Protected folders, wherever they are: every write inside them. */
export const PROTECTED_DIR_NAMES: readonly string[] = [".vscode", ".idea"];

const escape = (name: string): string => name.replace(/[.]/g, "\\.");

/**
 * The Seatbelt regexes (POSIX extended, matched on the resolved path).
 * Written as plain strings here; `seatbeltProtectedWriteRule` puts them
 * into `#"..."` literals.
 */
export const SEATBELT_PROTECTED_PATTERNS: readonly string[] = [
  // `.git` itself (create, rename, replace, delete) and a `.git` file.
  "/\\.git$",
  "/\\.git/hooks(/.*)?$",
  "/\\.git/config$",
  // Submodule git folders keep their own hooks and config.
  "/\\.git/modules/(.+/)?hooks(/.*)?$",
  "/\\.git/modules/(.+/)?config$",
  `/(${PROTECTED_FILE_NAMES.map(escape).join("|")})$`,
  "/\\.config/fish(/.*)?$",
  `/(${PROTECTED_DIR_NAMES.map(escape).join("|")})(/.*)?$`,
];

/** The Seatbelt rule; it goes after every rule that allows a write. */
export function seatbeltProtectedWriteRule(): string {
  const regexes = SEATBELT_PROTECTED_PATTERNS.map((re) => `(regex #"${re}")`);
  return `(deny file-write* ${regexes.join(" ")})`;
}

export interface ProtectedScanLimits {
  /** Folder levels below each root searched (the root is level 0). */
  maxDepth?: number;
  /** Folders read in all, so a huge tree cannot stall a command. */
  maxDirs?: number;
}

/** Never searched: large and never holds a project's own config. */
const SKIP_DIRS = new Set(["node_modules", ".hg", ".svn"]);

function lstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * What to bind read-only for one `.git`: the hooks folder (the whole
 * `.git` when it has none, so one cannot be made), the config, and the
 * same for each submodule's git folder. A `.git` file (a worktree or a
 * submodule pointer) is protected itself: rewritten, it would point git
 * at a folder of the command's choosing.
 */
function gitProtected(gitPath: string, out: string[], depth = 0): void {
  const st = lstat(gitPath);
  if (st === null) return;
  if (!st.isDirectory()) {
    out.push(gitPath);
    return;
  }
  const hooks = join(gitPath, "hooks");
  out.push(lstat(hooks) === null ? gitPath : hooks);
  const config = join(gitPath, "config");
  if (lstat(config) !== null) out.push(config);
  const modules = join(gitPath, "modules");
  if (depth >= 3 || lstat(modules)?.isDirectory() !== true) return;
  for (const name of names(modules)) gitProtected(join(modules, name), out, depth + 1);
}

/**
 * The protected paths that exist under the working folders (Linux).
 * Links are not followed into; a protected name that is a link is
 * listed itself (bwrap binds over what it points at).
 */
export function findProtectedPaths(
  roots: readonly string[],
  limits: ProtectedScanLimits = {},
): string[] {
  const maxDepth = limits.maxDepth ?? 3;
  let budget = limits.maxDirs ?? 3000;
  const out: string[] = [];
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  while (queue.length > 0 && budget > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    budget -= 1;
    for (const name of names(dir)) {
      const path = join(dir, name);
      if (name === ".git") {
        gitProtected(path, out);
        continue;
      }
      if (PROTECTED_FILE_NAMES.includes(name) || PROTECTED_DIR_NAMES.includes(name)) {
        out.push(path);
        continue;
      }
      const st = lstat(path);
      if (st === null || !st.isDirectory() || SKIP_DIRS.has(name)) continue;
      if (name === ".config" && lstat(join(path, "fish")) !== null) {
        out.push(join(path, "fish"));
      }
      if (depth < maxDepth) queue.push({ dir: path, depth: depth + 1 });
    }
  }
  return [...new Set(out)];
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The bwrap mounts for the protected paths. Each one that resolves to
 * something (a dangling link cannot be bound) is bound read-only, minus
 * those inside a hidden (denied) folder that is not opened again:
 * binding one back would show what the tmpfs hides.
 *
 * First, every folder between a working folder and a protected path
 * (`.git` included) is bound onto itself, writable as before. That makes
 * each a mount point, and a mount point cannot be renamed or removed
 * (`EBUSY`): otherwise `mv .git old && mkdir -p .git/hooks` (or moving
 * the folder that holds a nested repo) would leave a fresh, unprotected
 * `.git` in place for the user's next commit.
 */
export function bwrapProtectedArgs(
  paths: readonly string[],
  roots: readonly string[],
  hidden: readonly string[],
  reopened: readonly string[],
): string[] {
  const keep = paths.filter((path) => {
    if (!existsSync(path)) return false;
    const covered = hidden.some((dir) => isInside(path, dir));
    return !covered || reopened.some((dir) => isInside(path, dir));
  });
  const folders = new Set<string>();
  for (const path of keep) {
    const root = roots.find((r) => isInside(path, r) && r !== path);
    if (root === undefined) continue;
    for (let dir = dirname(path); dir !== root && isInside(dir, root); dir = dirname(dir)) {
      folders.add(dir);
    }
  }
  // Outer folders first, so an inner bind lands on top of an outer one.
  const binds = [...folders].sort((a, b) => a.length - b.length);
  return [
    ...binds.flatMap((dir) => ["--bind", dir, dir]),
    ...keep.flatMap((path) => ["--ro-bind", path, path]),
  ];
}
