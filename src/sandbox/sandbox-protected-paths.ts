/**
 * Paths a sandboxed command may not write even inside its working folder
 * (ATO-2471). The working folder is writable, but some files in it run
 * code later, outside the sandbox: a git hook on the user's next commit,
 * `core.hooksPath` or `core.fsmonitor` in `.git/config`, a `commondir`
 * that points git at a copy of the repo with its own hooks, a hooks
 * folder in the work tree (husky, `core.hooksPath`), a shell rc file in
 * a dotfiles repo linked into the home folder, `.envrc` on the next `cd`
 * with direnv, a VS Code task or a JetBrains run configuration on the
 * next open. Same class as the package-cache escape of ATO-1651.
 *
 * Same list as Claude Code's sandbox-runtime mandatory deny paths (shell
 * rc files, `.gitconfig`, `.gitmodules`, `.git/hooks`, `.git/config`,
 * `.vscode`, `.idea`), plus `.envrc`, fish's and git's XDG config and
 * the hook managers' files; Codex keeps `.git` read-only in its
 * `workspace-write` profile.
 *
 * - macOS: fixed Seatbelt regexes, at any depth (no outside text goes
 *   into the profile). Seatbelt matches resolved paths, so a link to a
 *   hook does not get around it. Nothing inside a `.git` is writable
 *   except the data git itself writes (objects, refs, logs, the index,
 *   `HEAD` and the other state files, their locks), so `config`,
 *   `commondir`, `hooks`, `info` and a worktree's `gitdir` stay as they
 *   are. `.git` itself cannot be created, renamed or replaced.
 * - Linux: bwrap has no patterns, so the working folders are searched
 *   (depth 3, as Claude Code does) and each protected path that exists
 *   is bound back read-only, each `.git` whole (git commands that write
 *   the repo fail inside the sandbox there, as in Codex), and the
 *   folders above each one are made mount points so they cannot be
 *   renamed away. A protected path that does not exist yet is not
 *   covered on Linux (bwrap would have to create it on the user's disk
 *   as a mount point).
 * - Both: the folder `core.hooksPath` names and the files the git
 *   config includes (`git-hooks-path.ts`) are protected too, and so is
 *   a git folder with another name (a `.git` file's `gitdir:`, its
 *   `commondir`, a bare repo; `git-dirs.ts`): on macOS like a `.git`, on
 *   Linux read-only whole.
 */
import { existsSync, lstatSync, readdirSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { GIT_DATA_DIRS } from "./git-dirs.js";

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
  // Hook managers: their config names the commands a hook runs.
  ".pre-commit-config.yaml",
  "lefthook.yml",
  ".lefthook.yml",
];

/** Protected folders, wherever they are: every write inside them. */
export const PROTECTED_DIR_NAMES: readonly string[] = [
  ".vscode",
  ".idea",
  // Hook folders in the work tree (husky, the usual `core.hooksPath`).
  ".husky",
  ".githooks",
];

/** Protected folders under a `.config` folder (fish, git's XDG config). */
export const PROTECTED_XDG_DIRS: readonly string[] = ["fish", "git"];

const escape = (name: string): string => name.replace(/[.]/g, "\\.");

/**
 * The Seatbelt regexes (POSIX extended, matched on the resolved path).
 * Written as plain strings here; `seatbeltProtectedWriteRule` puts them
 * into `#"..."` literals.
 */
export const SEATBELT_PROTECTED_PATTERNS: readonly string[] = [
  `/(${PROTECTED_FILE_NAMES.map(escape).join("|")})$`,
  `/\\.config/(${PROTECTED_XDG_DIRS.join("|")})(/.*)?$`,
  `/(${PROTECTED_DIR_NAMES.map(escape).join("|")})(/.*)?$`,
  // A submodule whose name ends in a data folder's name (`lib/refs`):
  // `.git/modules/lib/refs/hooks/pre-commit` also reads as submodule
  // `lib`'s refs, which the git rule below leaves writable. What runs
  // code stays read-only under `modules/` whatever the reading.
  "/\\.git/modules/.+/(hooks(/.*)?|config|config\\.worktree|commondir|gitdir|sequencer(/.*)?|rebase-merge(/.*)?|rebase-apply(/.*)?)$",
];

/** `.git` itself (create, rename, replace, delete) and all inside it. */
export const SEATBELT_GIT_PATTERN = "/\\.git(/.*)?$";

/** A git folder: the repo's, a submodule's or a linked worktree's. */
export const GIT_PREFIX = "/\\.git/(modules/.+/|worktrees/[^/]+/)?";

/** State files git writes in a git folder (each with its `.lock`). */
const GIT_STATE_FILES = [
  "HEAD", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE",
  "MERGE_RR", "AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
  "BISECT_[A-Z_]+", "NOTES_MERGE_REF", "COMMIT_EDITMSG", "TAG_EDITMSG",
  "SQUASH_MSG", "NOTES_EDITMSG", "packed-refs", "packed-refs\\.new", "shallow", "gc\\.pid", "gc\\.log",
  // Review round 2 (false blocks): `git add -e`'s patch, `merge --autostash`,
  // gitk's cache. Data, never a program.
  "ADD_EDIT\\.patch", "MERGE_AUTOSTASH", "gitk\\.cache",
];

/** The index and its temporary and split copies. */
const GIT_INDEX_FILES = ["index(\\.[^/]*)?", "sharedindex\\.[0-9a-f]+", "next-index-[0-9]+\\.lock"];

/** The name of a file git writes in a git folder, at the end of a path. */
export const SEATBELT_GIT_STATE_FILE_PATTERN = `/(${GIT_INDEX_FILES.join("|")}|(${GIT_STATE_FILES.join("|")})(\\.lock)?)$`;

/**
 * Inside a `.git`, what git itself writes, and only that: data that
 * never names a program. `config`, `config.worktree`, `commondir`,
 * `gitdir`, `hooks`, `info` and anything new stay read-only, and so do
 * `rebase-merge` and `rebase-apply` (review R2-1991.B: their todo list
 * takes `exec <command>` lines, which `git rebase --continue` runs
 * outside the sandbox; `git rebase` fails inside it instead) and
 * `sequencer` (review F1991-R3.1: its `opts` names a merge strategy that
 * `git cherry-pick --continue` runs; a cherry-pick or revert of several
 * commits fails inside it).
 */
export const SEATBELT_GIT_WRITABLE_PATTERNS: readonly string[] = [
  `${GIT_PREFIX}(${GIT_DATA_DIRS.join("|")})(/.*)?$`,
  `${GIT_PREFIX}${SEATBELT_GIT_STATE_FILE_PATTERN.slice(1)}`,
];

/**
 * The Seatbelt rules; they go after every rule that allows a write.
 * `extraParams` names `-D` parameters holding more protected folders
 * and files (`core.hooksPath`, included git config files).
 */
export function seatbeltProtectedWriteRule(extraParams: readonly string[] = []): string {
  const regexes = SEATBELT_PROTECTED_PATTERNS.map((re) => `(regex #"${re}")`);
  const extra = extraParams.map((name) => ` (subpath (param "${name}"))`).join("");
  const gitData = SEATBELT_GIT_WRITABLE_PATTERNS.map((re) => `(regex #"${re}")`);
  return [
    `(deny file-write* ${regexes.join(" ")}${extra})`,
    `(deny file-write* (require-all (regex #"${SEATBELT_GIT_PATTERN}") (require-not (require-any ${gitData.join(" ")}))))`,
  ].join("\n");
}

/** The `-D` parameter names of one git folder not named `.git` (`git-dirs.ts`). */
export interface SeatbeltGitDirParams {
  /** The git folder. */
  dir: string;
  /** Its data folders (and its worktrees' and submodules'). */
  data: readonly string[];
}

/**
 * The rules for git folders not named `.git` (review R2-1991.A), one per
 * folder: the same as for a `.git`, writes inside it only to its data
 * folders and to a file git writes (`HEAD`, the index, ...). Paths come
 * as parameters; the one regex is fixed and only matches the last name.
 */
export function seatbeltGitDirRules(dirs: readonly SeatbeltGitDirParams[]): string[] {
  return dirs.map(({ dir, data }) => {
    const keep = [
      `(regex #"${SEATBELT_GIT_STATE_FILE_PATTERN}")`,
      ...data.map((name) => `(subpath (param "${name}"))`),
    ];
    return `(deny file-write* (require-all (subpath (param "${dir}")) (require-not (require-any ${keep.join(" ")}))))`;
  });
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
      // A `.git` is read-only whole: its config, hooks and `commondir`
      // (which can point git at a copy with other hooks) all run code.
      // A `.git` file (a worktree or submodule pointer) likewise: it
      // would point git at a folder of the command's choosing.
      if (name === ".git" || PROTECTED_FILE_NAMES.includes(name) || PROTECTED_DIR_NAMES.includes(name)) {
        out.push(path);
        continue;
      }
      const st = lstat(path);
      if (st === null || !st.isDirectory() || SKIP_DIRS.has(name)) continue;
      if (name === ".config") {
        for (const sub of PROTECTED_XDG_DIRS) {
          if (lstat(join(path, sub)) !== null) out.push(join(path, sub));
        }
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
 * First, every folder between a working folder and a protected path is
 * bound onto itself, writable as before. That makes each a mount point
 * (as is each protected path), and a mount point cannot be renamed or
 * removed (`EBUSY`): otherwise moving the folder that holds a nested
 * repo (or `mv .git old && mkdir -p .git/hooks`) would leave a fresh,
 * unprotected `.git` in place for the user's next commit.
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
