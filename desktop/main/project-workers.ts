/*
 * ATO-1173 (first slice): a chat in a project splits a big task into up to
 * three worker chats, each working in its own copy of the project folder, so
 * they can change files at the same time without stepping on each other or
 * on the folder the person has open. The way Cursor's background agents,
 * Conductor and Claude Code's parallel sessions do it: one git worktree per
 * worker.
 *
 * This file is the pure part: which tasks are taken, where a worker's copy
 * goes and how it is made (the command runner is passed in, so the tests see
 * the exact argv and nothing ever goes through a shell), what a worker is
 * asked, and the short report its coordinator gets back. The records live in
 * project-workers-store.ts; the IPC in project-workers-ipc.ts.
 *
 * Not here yet (the rest of ATO-1173): the model splitting the task by
 * itself, merging the copies back, a shared check, a budget per worker,
 * removing a copy.
 */
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gitSafeArgs } from "./git-safe-args.js";

export const MAX_WORKERS = 3;
/** A task is a short brief, not a document; a longer one is cut, not refused. */
export const MAX_TASK_CHARS = 4000;
/** A folder copy (no git) bigger than this is refused: the copy would take minutes and fill the disk. */
export const MAX_COPY_FILES = 20000;
export const MAX_COPY_BYTES = 500 * 1024 * 1024;
/** What the coordinator gets from one worker, at most. */
export const MAX_SUMMARY_LINES = 5;
export const MAX_SUMMARY_CHARS = 600;

export const WORKER_REPORT_ASK = "When you finish, end with a short summary (at most 5 lines) for the coordinator: what changed and where.";

/** Runs one program with its arguments, never a shell (child_process.execFile, promisified). */
export type Exec = (file: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

/**
 * `error` is the sentence the window shows. ATO-2744: when a tool failed,
 * `detail` has its raw words (git's stderr, the errno) for Details, and
 * `reason: "git"` says git refused, so the window can say which known case
 * it is (renderer/human-error.js herrGitWorktree).
 */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; detail?: string; reason?: "git" };

/** The tasks the person typed: trimmed, the empty ones dropped, 1 to 3 of them, each cut to MAX_TASK_CHARS. */
export function planWorkers(tasks: unknown): Result<{ tasks: string[] }> {
  if (!Array.isArray(tasks)) return { ok: false, error: "tasks must be a list" };
  const clean = tasks
    .filter((t): t is string => typeof t === "string")
    .map((t) => Array.from(t.replace(/\0/g, "").trim()).slice(0, MAX_TASK_CHARS).join(""))
    .filter((t) => t.length > 0);
  if (clean.length === 0) return { ok: false, error: "Write at least one task" };
  if (clean.length > MAX_WORKERS) return { ok: false, error: `At most ${MAX_WORKERS} worker chats at a time` };
  return { ok: true, tasks: clean };
}

/** The first message a worker chat gets: its task, and how to report back. */
export function workerPrompt(task: string): string {
  return `${task.trim()}\n\n${WORKER_REPORT_ASK}`;
}

/** A name safe as one folder name: the project id and a counter only. */
export function workerKey(projectId: string, stamp: number, n: number): string {
  const id = projectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "project";
  return `${id}-${Math.max(0, Math.floor(stamp)).toString(36)}-${n}`;
}

export function worktreesDir(stateDir: string): string {
  return join(stateDir, "worktrees");
}

export interface WorkerDir {
  /** Where the worker's chat works: the copy of the project folder. */
  dir: string;
  /** The copy's top: the worktree (dir may be a subfolder of it) or the copied folder. */
  root: string;
  kind: "worktree" | "copy";
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/** The repo's top folder when `folder` is inside a git work tree, else null. */
export async function gitTop(folder: string, exec: Exec, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    const { stdout } = await exec("git", [...gitSafeArgs(platform), "-C", folder, "rev-parse", "--show-toplevel"], { timeout: 15000 });
    const top = stdout.trim();
    return top ? top : null;
  } catch {
    return null;
  }
}

/** Counts files and bytes under `dir`, stopping as soon as either cap is passed. Symlinks are counted, not followed. */
export async function folderTooBig(dir: string, caps = { files: MAX_COPY_FILES, bytes: MAX_COPY_BYTES }): Promise<string | null> {
  let files = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      files++;
      if (e.isFile()) { try { bytes += (await lstat(p)).size; } catch { /* gone meanwhile */ } }
      if (files > caps.files) return `The folder has more than ${caps.files} files; put it under git to give workers their own copies`;
      if (bytes > caps.bytes) return `The folder is larger than ${Math.round(caps.bytes / 1024 / 1024)} MB; put it under git to give workers their own copies`;
    }
  }
  return null;
}

/**
 * Make one worker's copy of the project folder under
 * `<stateDir>/worktrees/<key>`. A folder in a git repo gets a detached
 * worktree of HEAD (so the copy has the last commit, not uncommitted
 * changes); any other folder is copied, by an APFS clone on macOS where
 * that works (`cp -c`, near free), else file by file, and refused past the
 * size caps. Never deletes anything, and refuses a target that is there.
 */
export async function makeWorkerDir(
  projectFolder: string,
  stateDir: string,
  key: string,
  exec: Exec,
  platform: NodeJS.Platform = process.platform,
): Promise<Result<WorkerDir>> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) return { ok: false, error: "bad worker key" };
  try {
    if (!(await stat(projectFolder)).isDirectory()) return { ok: false, error: "The project folder is not a folder" };
  } catch {
    return { ok: false, error: "The project folder is not there" };
  }
  const base = worktreesDir(stateDir);
  const root = join(base, key);
  if (await exists(root)) return { ok: false, error: "A worker copy with this name is already there" };
  // The copy must never land inside the folder it copies (it would copy itself).
  const inside = relative(projectFolder, root);
  if (inside === "" || (!inside.startsWith("..") && !inside.startsWith(sep) && !/^[A-Za-z]:/.test(inside))) {
    return { ok: false, error: "The project folder holds the agent's own state folder" };
  }
  try { await mkdir(base, { recursive: true }); } catch (e) { return { ok: false, error: "Couldn't make the folder for worker copies.", detail: errRaw(e) }; }

  const top = await gitTop(projectFolder, exec, platform);
  if (top) {
    try {
      // No hook of the project's own repo runs on checkout (ATO-2532).
      await exec("git", [...gitSafeArgs(platform), "-C", top, "worktree", "add", "--detach", root, "HEAD"], { timeout: 120000 });
    } catch (e) {
      return { ok: false, error: "Couldn't make a worker copy of this folder with git.", detail: errRaw(e), reason: "git" };
    }
    // A project on a subfolder of the repo works in the same subfolder of its worktree.
    const sub = relative(top, projectFolder);
    return { ok: true, root, dir: sub && !sub.startsWith("..") ? join(root, sub) : root, kind: "worktree" };
  }

  const big = await folderTooBig(projectFolder);
  if (big) return { ok: false, error: big };
  if (platform === "darwin") {
    try {
      // No trailing slash on the source: BSD cp would copy its contents instead of the folder.
      await exec("cp", ["-c", "-R", projectFolder.replace(/\/+$/, "") || "/", root], { timeout: 300000 });
      return { ok: true, root, dir: root, kind: "copy" };
    } catch {
      // Not APFS (or a partial clone): a partial copy is not deleted here; the plain copy below refuses to overwrite it.
      if (await exists(root)) return { ok: false, error: "The folder copy stopped halfway. The part already copied was kept.", detail: root };
    }
  }
  try {
    await cp(projectFolder, root, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (e) {
    return { ok: false, error: "Couldn't copy the folder for the worker.", detail: errRaw(e) };
  }
  return { ok: true, root, dir: root, kind: "copy" };
}

/** What a failed call said, whole: execFile's stderr when it kept one (git's "fatal: …"), else the message. */
function errRaw(e: unknown): string {
  const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr ?? "").trim() : "";
  const m = e instanceof Error ? e.message : String(e);
  return (stderr || m).trim().slice(0, 2000);
}

/**
 * A worker's last reply, cut for the coordinator: its last few non-empty
 * lines (the summary the worker was asked to end with), at most
 * MAX_SUMMARY_CHARS. Empty when the worker said nothing.
 */
export function replySummary(text: string): string {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-MAX_SUMMARY_LINES).join("\n").trim();
  if (tail.length <= MAX_SUMMARY_CHARS) return tail;
  return "…" + tail.slice(tail.length - MAX_SUMMARY_CHARS + 1);
}

export interface ReportWorker { task: string; dir: string; status: string; summary?: string }

/** The first line of a task, short, for a list item. */
export function taskTitle(task: string, max = 80): string {
  const line = String(task || "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const chars = Array.from(line.trim());
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

/**
 * What goes into the coordinator's composer once every worker has ended
 * (never sent by itself): one item per worker with its summary and the
 * folder its changes are in.
 */
export function coordinatorReport(workers: readonly ReportWorker[]): string {
  const items = workers.map((w) => {
    const said = w.summary && w.summary.trim() ? w.summary.trim() : w.status === "done" ? "(finished without a summary)" : `(${w.status}, no summary)`;
    const body = said.includes("\n") ? "\n  " + said.split("\n").join("\n  ") : " " + said;
    return `- ${taskTitle(w.task)}${w.status === "done" ? "" : ` [${w.status}]`}:${body}\n  Folder: ${w.dir}`;
  });
  return `Worker results:\n${items.join("\n")}`;
}
