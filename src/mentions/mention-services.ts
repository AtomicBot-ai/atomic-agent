/**
 * The runtime's mention services (ATO-2472): one expansion for every
 * surface. The terminal calls it in process through
 * `runtime.mentions`; the desktop through `POST /api/mentions/expand` and
 * `GET /api/problems` (src/http/route-mentions.ts).
 */

import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import {
  collectWorkspaceProblems,
  type LspServerPool,
  type WorkspaceProblems,
} from "../tools/os/fs/lsp/index.js";
import { DEFAULT_CONTEXT_DEPS, expandMentions, hasContextMentions, type ContextMentionDeps } from "./context-mentions.js";
import { expandFileMentions, DEFAULT_MENTION_LIMITS, type IsProtectedPath } from "./expand-file-mentions.js";
import { changedFilesArgs, type RunGit } from "./mention-git.js";

/** Most untracked files counted as changed for `@problems`. */
const MAX_UNTRACKED = 200;

export interface MentionServices {
  /** `text` with its `@` mentions inlined, read inside `workingDir` only. */
  expand(text: string, workingDir: string): Promise<string>;
  /**
   * The same without waiting, when `text` mentions only plain files (or
   * nothing); `null` when it has a kind that needs git, the network or a
   * language server, which only `expand` reads.
   */
  expandNow(text: string, workingDir: string): string | null;
  /** The language servers' problems for `workingDir`. */
  problems(workingDir: string): Promise<WorkspaceProblems>;
}

export interface MentionServicesOptions {
  /** The pool registerOsTools built, read per call; null when language servers are off. */
  lspPool: () => LspServerPool | null;
  /** `getStateSecretPaths(config.paths)`: never inlined. Entries ending in a separator are folders of code and are not refused. */
  protectedFiles: readonly string[];
  /**
   * ATO-2496: `getStateSecretDirectories(stateDir)`, the sign-in folders
   * (`auth/`, `mcp-oauth/`, `whatsapp-auth/`). No file inside one is inlined.
   */
  protectedFolders?: readonly string[];
  deps?: Partial<ContextMentionDeps>;
  platform?: NodeJS.Platform;
}

// The native realpath returns the spelling on disk, as read-scope.ts
// canonical() does; the JS one keeps the typed case, so `@.ENV` on a
// case-insensitive macOS volume would miss the protected `.env`. A path
// that does not exist yet (`mcp-oauth/` before the first sign-in) keeps
// the real path of its nearest existing parent, so a symlinked state
// folder still matches the real path a later mention resolves to.
function canonicalOf(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/**
 * A check against the protected files, by real path, and against every
 * file inside one of `folders`. Case is folded on Windows and macOS, whose
 * default volumes ignore it: refusing a distinct `.ENV` on a
 * case-sensitive Mac volume is the safe side.
 */
export function protectedPathCheck(
  files: readonly string[],
  platform: NodeJS.Platform = process.platform,
  folders: readonly string[] = [],
): IsProtectedPath {
  const fold = (p: string): string => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const plainFiles = files.filter((f) => !f.endsWith(sep) && !f.endsWith("/"));
  const folderRoots = folders.map((f) => f.replace(/[\\/]+$/, ""));
  // Built per call, not once at boot: a folder or file created after
  // start (or a state folder whose link moved) is judged by its real
  // path now.
  return (real) => {
    const path = fold(canonicalOf(real));
    if (plainFiles.some((f) => fold(canonicalOf(f)) === path)) return true;
    return folderRoots.some((f) => path.startsWith(fold(canonicalOf(f)) + sep));
  };
}

/** Tracked changes and untracked files under `dir`, relative to it. */
export async function changedFilesUnder(git: RunGit, dir: string): Promise<string[]> {
  const split = (text: string): string[] => text.split("\0").filter((p) => p.length > 0);
  const tracked = await git(dir, changedFilesArgs()).then((o) => split(o.text), () => []);
  const untracked = await git(dir, ["ls-files", "-z", "--others", "--exclude-standard"])
    .then((o) => split(o.text).slice(0, MAX_UNTRACKED), () => []);
  return [...new Set([...tracked, ...untracked])];
}

export function createMentionServices(options: MentionServicesOptions): MentionServices {
  const base: ContextMentionDeps = { ...DEFAULT_CONTEXT_DEPS, ...options.deps };
  const isProtected = protectedPathCheck(options.protectedFiles, options.platform, options.protectedFolders);
  const problems = (workingDir: string): Promise<WorkspaceProblems> =>
    collectWorkspaceProblems({
      pool: options.lspPool(),
      workingDir,
      changedFiles: () => changedFilesUnder(base.runGit, workingDir),
    });
  const deps: ContextMentionDeps = { ...base, isProtected, problems };
  return {
    expand: (text, workingDir) => expandMentions(text, workingDir, deps),
    expandNow: (text, workingDir) =>
      hasContextMentions(text, workingDir) ? null : expandFileMentions(text, workingDir, DEFAULT_MENTION_LIMITS, isProtected),
    problems,
  };
}
