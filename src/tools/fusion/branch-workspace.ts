/**
 * A workspace per fusion task (branch isolation, ATO-946).
 *
 * Parallel workers used to write straight into the working directory:
 * two of them editing the same file raced, and a worker that went wrong
 * left its damage behind with nothing to throw away. With
 * `llm.runMode.fusion.isolation: "worktree"` every task of a wave gets
 * a workspace of its own, made from one snapshot of the working
 * directory taken just before the wave, plus one more workspace from
 * the same snapshot that nobody writes to: the merge base
 * (`branch-merge.ts`).
 *
 * Inside a git repo a workspace is a detached `git worktree` of a
 * snapshot commit: `git stash create` captures the tracked files'
 * uncommitted state without touching the working tree or the stash
 * list (HEAD when there is nothing uncommitted). Untracked files are
 * copied in; ignored directories (`node_modules`, build output) are
 * symlinked to the originals so a test run still finds them, and
 * ignored files are copied. Outside git, or when git cannot snapshot
 * (no commit yet, a merge in progress, no git binary), a workspace is
 * a folder copy: APFS clonefile on macOS, else the `verify.run` copy
 * with its exclusions symlinked. A tree too large to copy is not
 * isolated at all; the caller runs the wave in place and says so.
 *
 * Writes into a symlinked directory land in the original, as they do
 * for `verify.run`; nothing under one is merged, because it is already
 * there. Submodules are not checked out in a worktree.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { runCommand, type CommandResult } from "../../sandbox/command-runner.js";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import {
  copyTreeWithExclusions,
  measureTree,
  VERIFY_COPY_EXCLUDED,
  VERIFY_COPY_MAX_BYTES,
} from "../verify/verify-workspace-copy.js";

/** Where conflicting sides are saved for the merge task, relative to the working directory. */
export const BRANCH_MERGE_DIR = join(".atomic-agent", "fusion-merge");

export type BranchMethod = "worktree" | "clonefile" | "copy";

/** Size and mtime of one file at workspace creation: what "changed" is measured against. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface BranchWorkspace {
  readonly taskId: string;
  /** Short, path-safe name: the workspace's folder and its merge folder. */
  readonly name: string;
  /** The task's working directory: the working directory's twin inside the workspace. */
  readonly dir: string;
  /** Files as they were when the workspace was made, by path relative to `dir`. */
  readonly manifest: ReadonlyMap<string, FileStamp>;
}

export interface BranchSet {
  readonly method: BranchMethod;
  /** The working directory the workspaces mirror and are merged back into. */
  readonly realDir: string;
  /** The untouched snapshot every workspace started from. */
  readonly baseDir: string;
  readonly workspaces: ReadonlyMap<string, BranchWorkspace>;
  /** Removes every workspace (worktrees included) and prunes git's records. Never throws. */
  cleanup(): Promise<void>;
}

/** Runs git; resolves `null` when git is not there to run. */
export type GitExec = (
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult | null>;

export interface CreateBranchSetOptions {
  tmpRoot?: string;
  platform?: NodeJS.Platform;
  /** Test seam. */
  git?: GitExec;
  /** Test seam: a tree over this many bytes is not copied. */
  maxCopyBytes?: number;
}

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Git with no pager, no prompt, no hooks and none of the agent's keys
 * in its environment (the same rules as `runGit`).
 */
export const defaultGitExec: GitExec = async (args, cwd) => {
  try {
    return await runCommand(
      "git",
      ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd,
        env: {
          ...buildCommandEnv(process.env),
          GIT_PAGER: "",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      },
    );
  } catch {
    return null;
  }
};

function ok(result: CommandResult | null): result is CommandResult {
  return (
    result !== null &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.truncated
  );
}

/** `NUL`-separated git output as a list, empty entries dropped. */
function zList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** `t0-build_parser`: index first so two ids that sanitise alike stay apart. */
export function workspaceName(index: number, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `t${index}-${safe}`;
}

function isUnderMergeDir(rel: string): boolean {
  return rel === BRANCH_MERGE_DIR || rel.startsWith(`${BRANCH_MERGE_DIR}${sep}`);
}

/**
 * Every regular file under `root` with its size and mtime. Symlinks are
 * not followed, the copy exclusions (`.git`, `node_modules`, …) and the
 * merge folder are skipped: none of it is merged back.
 */
export async function stampTree(root: string): Promise<Map<string, FileStamp>> {
  const out = new Map<string, FileStamp>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (VERIFY_COPY_EXCLUDED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (isUnderMergeDir(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const info = await lstat(full);
          out.set(rel, { size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // Vanished mid-walk.
        }
      }
    }
  }
  return out;
}

async function copyFileKeepingMode(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  const mode = (await lstat(from)).mode & 0o777;
  if (mode & 0o111) await chmod(to, mode);
}

/** What a git snapshot needs: the commit, and what lives outside it. */
interface GitSnapshot {
  top: string;
  /** The working directory relative to the repo's top. */
  rel: string;
  commit: string;
  untracked: string[];
  /** Ignored entries; a trailing `/` marks a directory. */
  ignored: string[];
}

async function gitSnapshot(
  realDir: string,
  git: GitExec,
): Promise<GitSnapshot | null> {
  const topResult = await git(["rev-parse", "--show-toplevel"], realDir);
  if (!ok(topResult)) return null;
  const top = await realpath(topResult.stdout.trim()).catch(() => null);
  if (top === null) return null;
  const rel = relative(top, realDir);
  if (rel.startsWith("..")) return null;
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], realDir);
  if (!ok(head)) return null;
  // A commit object of the tracked files' current state; the working
  // tree, the index and the stash list are left exactly as they were.
  const stash = await git(["stash", "create"], realDir);
  if (!ok(stash)) return null;
  const commit = stash.stdout.trim() || head.stdout.trim();
  const untracked = await git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    realDir,
  );
  const ignored = await git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    realDir,
  );
  if (!ok(untracked) || !ok(ignored)) return null;
  return {
    top,
    rel,
    commit,
    untracked: zList(untracked.stdout),
    ignored: zList(ignored.stdout),
  };
}

/** One worktree of the snapshot at `root`, with what git does not carry copied or linked in. */
async function addWorktree(
  snapshot: GitSnapshot,
  realDir: string,
  root: string,
  git: GitExec,
): Promise<string> {
  const added = await git(
    ["worktree", "add", "--detach", "--quiet", root, snapshot.commit],
    snapshot.top,
  );
  // Read before `ok` narrows: its false branch types a failed run as null.
  const failure = added?.stderr ?? "git not found";
  if (!ok(added)) {
    throw new Error(`git worktree add failed: ${failure.trim()}`);
  }
  const dir = snapshot.rel.length === 0 ? root : join(root, snapshot.rel);
  await mkdir(dir, { recursive: true });
  for (const path of snapshot.untracked) {
    await copyFileKeepingMode(join(realDir, path), join(dir, path)).catch(
      () => undefined,
    );
  }
  for (const entry of snapshot.ignored) {
    const isDir = entry.endsWith("/");
    const path = isDir ? entry.slice(0, -1) : entry;
    const from = join(realDir, path);
    const to = join(dir, path);
    try {
      if (isDir) {
        await mkdir(dirname(to), { recursive: true });
        await symlink(from, to, "dir");
      } else {
        await copyFileKeepingMode(from, to);
      }
    } catch {
      // An ignored entry that cannot be mirrored is one a worker cannot
      // see; not a reason to give up the isolation.
    }
  }
  return dir;
}

function cloneWithCp(src: string, dest: string): Promise<boolean> {
  return runCommand("cp", ["-c", "-R", src, dest], {
    cwd: dirname(dest),
    timeoutMs: 300_000,
  })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
}

async function copyWorkspace(
  realDir: string,
  root: string,
  platform: NodeJS.Platform,
): Promise<BranchMethod> {
  if (platform === "darwin" && (await cloneWithCp(realDir, root))) {
    return "clonefile";
  }
  await rm(root, { recursive: true, force: true });
  await copyTreeWithExclusions(realDir, root);
  return "copy";
}

/**
 * The base and one workspace per task, all from one snapshot of
 * `realDir`. `null` when nothing can be isolated (a tree too large to
 * copy); throws only when a workspace that was started cannot be
 * finished, after removing what was made.
 */
export async function createBranchSet(
  realDir: string,
  taskIds: readonly string[],
  options: CreateBranchSetOptions = {},
): Promise<BranchSet | null> {
  const git = options.git ?? defaultGitExec;
  const platform = options.platform ?? process.platform;
  const real = await realpath(realDir);
  const runRoot = await realpath(
    await mkdtemp(
      join(
        options.tmpRoot ?? tmpdir(),
        `atag-fusion-${randomBytes(3).toString("hex")}-`,
      ),
    ),
  );
  const snapshot = await gitSnapshot(real, git);
  const roots: string[] = [];
  const cleanup = async (): Promise<void> => {
    if (snapshot !== null) {
      for (const root of roots) {
        await git(["worktree", "remove", "--force", root], snapshot.top).catch(
          () => null,
        );
      }
    }
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    if (snapshot !== null) {
      await git(["worktree", "prune"], snapshot.top).catch(() => null);
    }
  };
  if (snapshot === null) {
    const limit = options.maxCopyBytes ?? VERIFY_COPY_MAX_BYTES;
    if ((await measureTree(real, limit)) > limit) {
      await cleanup();
      return null;
    }
  }
  try {
    let method: BranchMethod = "worktree";
    const make = async (name: string): Promise<string> => {
      const root = join(runRoot, name);
      roots.push(root);
      if (snapshot !== null) return addWorktree(snapshot, real, root, git);
      method = await copyWorkspace(real, root, platform);
      return root;
    };
    const baseDir = await make("base");
    const workspaces = new Map<string, BranchWorkspace>();
    for (const [index, taskId] of taskIds.entries()) {
      const name = workspaceName(index, taskId);
      const dir = await make(name);
      workspaces.set(taskId, {
        taskId,
        name,
        dir,
        manifest: await stampTree(dir),
      });
    }
    return { method, realDir: real, baseDir, workspaces, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * The paths (relative to the workspace's `dir`) a task added, changed or
 * removed, judged by size and mtime against its manifest. A file merely
 * touched is weeded out later by comparing bytes with the base.
 */
export async function touchedPaths(
  workspace: BranchWorkspace,
): Promise<string[]> {
  const now = await stampTree(workspace.dir);
  const out: string[] = [];
  for (const [rel, stamp] of now) {
    const before = workspace.manifest.get(rel);
    if (
      before === undefined ||
      before.size !== stamp.size ||
      before.mtimeMs !== stamp.mtimeMs
    ) {
      out.push(rel);
    }
  }
  for (const rel of workspace.manifest.keys()) {
    if (!now.has(rel)) out.push(rel);
  }
  return out.sort();
}
