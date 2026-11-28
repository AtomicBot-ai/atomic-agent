/**
 * Review F1991-R3.2 (ATO-2471): a git folder the sandboxed command makes
 * itself. The git folders are found once, when the profile is built
 * (`git-dirs.ts`), so a folder made during the command is not among
 * them: `mkdir -p src/objects src/refs`, a `src/HEAD` and a `src/config`
 * with `worktree = ..` and `core.fsmonitor = <command>` make `src` a
 * repo, and the user's next `git status` in it runs the command outside
 * the sandbox.
 *
 * Git takes a folder for a git folder only when it holds `HEAD` (a file
 * or a link) next to `objects` and `refs` (`is_git_directory`). So on
 * macOS a path named `HEAD` may be written only where git keeps one: at
 * the top of a known git folder, in its `logs/` and under
 * `refs/remotes/<remote>/`. Not made, linked or renamed into place
 * anywhere else (Seatbelt checks the new name of a rename too, and
 * matches names without regard to case on a case-insensitive disk, so
 * `head` is covered). The folders that hold such a `HEAD` (`logs`,
 * `refs`, `refs/remotes/...`, anything in `modules/`, where a submodule's
 * name can look like a data folder) may not be removed or renamed, so
 * none is moved out with its `HEAD`; other ref folders still can be.
 * A git folder not named `.git` (`.bare`) is named by `-D` parameters,
 * so there the whole folder is treated that way.
 *
 * Linux (bwrap) has no patterns; a path that does not exist yet is not
 * covered there (ATO-2787), and this is one.
 */
import { GIT_PREFIX } from "./sandbox-protected-paths.js";

/** Where git keeps a file named `HEAD` in a `.git` (or its worktrees and submodules). */
export const SEATBELT_GIT_HEAD_PATTERN = `${GIT_PREFIX}(logs/)?(refs/remotes/.+/)?HEAD$`;

/** Folders in a `.git` that hold such a `HEAD`: never removed or renamed. */
export const SEATBELT_GIT_HEAD_FOLDER_PATTERNS: readonly string[] = [
  `${GIT_PREFIX}(logs|logs/refs|refs|(logs/)?refs/remotes(/.*)?)$`,
  "/\\.git/modules/",
];

/**
 * The Seatbelt rules; they go after every rule that allows a write.
 * `gitDirParams` names the `-D` parameters of the git folders not named
 * `.git` (`seatbeltGitDirRules`).
 */
export function seatbeltNewGitDirRules(gitDirParams: readonly string[]): string[] {
  const dirs = gitDirParams.map((name) => `(subpath (param "${name}"))`);
  const heads = [`(regex #"${SEATBELT_GIT_HEAD_PATTERN}")`, ...dirs];
  const folders = [...SEATBELT_GIT_HEAD_FOLDER_PATTERNS.map((re) => `(regex #"${re}")`), ...dirs];
  return [
    `(deny file-write* (require-all (regex #"/HEAD$") (require-not (require-any ${heads.join(" ")}))))`,
    `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (require-any ${folders.join(" ")})))`,
  ];
}
