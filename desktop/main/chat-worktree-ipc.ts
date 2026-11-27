/* ATO-576 — "New chat in its own branch" for a project, and the project's
   list of the agent's worktrees with Remove.

   The agent's `/new worktree` (src/tui/session-worktree-start.ts) is a
   terminal command: no HTTP route starts a chat in a worktree or lists
   them. So the desktop does the git work itself, in the same folder and
   with the same rules (chat-worktree-git.ts), and opens the chat there the
   way every new chat gets its folder: the first turn's `working_dir`.

   - Start: a git worktree and branch are made from the project's folder at
     once (a non-git folder is refused here, in plain words), named after a
     chat id fixed now. The next new chat of that project takes that id and
     opens in the worktree (`take`, from main.ts agent:chat). One at a time:
     a second Start replaces the first, whose worktree stays listed.
   - List: `git worktree list --porcelain` of the project's repository, only
     the worktrees under `<stateDir>/worktrees/` (the agent's and these), each
     with whether it may be removed.
   - Remove: only such a worktree, only when it holds nothing a removal would
     lose. The chat that worked there is moved back to the project's folder
     first (POST /api/sessions/{id}/working-dir); a chat running a turn
     refuses. Then `git worktree remove` (never `--force`) and `git branch -d`
     (a branch with unmerged commits stays). Same shape as Claude Code
     desktop's and the Codex app's worktree mode. */

import type { IpcMain } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { gitSafeArgs } from "./git-safe-args.js";
import { addWorktree, dirInWorktree, dirtyReason, isInside, parseWorktreePorcelain, type GitExec } from "./chat-worktree-git.js";

export interface WorktreeRecord { sessionId: string; originalWorkingDir: string }

export interface ChatWorktreeDeps {
  stateDir: string;
  git: GitExec;
  /** The project's folder on this computer, or null (no such project, or a project with no folder). */
  projectFolder: (projectId: string) => string | null;
  isRemote: () => boolean;
  newChatId: () => string;
  /** Move a stored chat to another folder (agent-client setSessionWorkingDir): `busy` while it runs a turn,
      `error` when the agent refused, `supported: false` when the agent has no such route or cannot be reached. */
  repoint: (sessionId: string, dir: string) => Promise<{ supported?: true; busy?: boolean; error?: string } | { supported: false }>;
}

export interface WorktreeRow { path: string; branch: string | null; removable: boolean; reason: string | null; sessionId: string | null }

const REMOTE = "Worktrees are made on the computer the agent runs on; this window is connected to another one.";

export function worktreesDir(stateDir: string): string {
  return join(stateDir, "worktrees");
}

/** Which chat worked in which worktree, for the ones the desktop made (the agent's own keep a `<path>.json` marker). */
function recordsPath(stateDir: string): string {
  return join(worktreesDir(stateDir), "desktop-chats.json");
}

export class ChatWorktrees {
  private armed: { projectId: string; chatId: string; dir: string } | null = null;

  constructor(private readonly deps: ChatWorktreeDeps) {}

  /** Make the worktree now; the project's next new chat opens in it. */
  async start(projectId: unknown): Promise<{ ok: true; branch: string; path: string } | { ok: false; error: string }> {
    if (this.deps.isRemote()) return { ok: false, error: REMOTE };
    const folder = typeof projectId === "string" ? this.deps.projectFolder(projectId) : null;
    if (!folder || typeof projectId !== "string") return { ok: false, error: "Only a project with a folder on this computer can have a chat in its own branch." };
    const chatId = this.deps.newChatId();
    const made = await addWorktree(this.deps.git, folder, worktreesDir(this.deps.stateDir), chatId, existsSync,
      (p) => realpath(p), async (p) => { await mkdir(p, { recursive: true }); });
    if ("error" in made) return { ok: false, error: made.error };
    const original = await realpath(folder).catch(() => folder);
    await this.saveRecord(made.path, { sessionId: chatId, originalWorkingDir: original });
    this.armed = { projectId, chatId, dir: dirInWorktree(made.repoRoot, original, made.path) };
    return { ok: true, branch: made.branch, path: made.path };
  }

  /** For agent:chat: the id and folder of a project's new chat, once. */
  take(projectId: string | undefined): { chatId: string; dir: string } | null {
    const a = this.armed;
    if (!a || !projectId || a.projectId !== projectId || !existsSync(a.dir)) return null;
    this.armed = null;
    return { chatId: a.chatId, dir: a.dir };
  }

  async list(projectId: unknown): Promise<{ ok: true; rows: WorktreeRow[] } | { ok: false; error: string }> {
    if (this.deps.isRemote()) return { ok: false, error: REMOTE };
    const folder = typeof projectId === "string" ? this.deps.projectFolder(projectId) : null;
    if (!folder) return { ok: true, rows: [] };
    const listed = await this.deps.git(["worktree", "list", "--porcelain"], folder);
    if (!listed || listed.code !== 0) return { ok: true, rows: [] };   // not a git folder: nothing to list
    const root = await realpath(worktreesDir(this.deps.stateDir)).catch(() => worktreesDir(this.deps.stateDir));
    const records = await this.readRecords();
    const rows: WorktreeRow[] = [];
    for (const w of parseWorktreePorcelain(listed.stdout)) {
      const path = await realpath(w.path).catch(() => w.path);
      if (!isInside(root, path)) continue;
      const reason = w.locked ? "Git has it locked." : await this.dirty(path);
      const who = records[path] ?? (await this.marker(path));
      rows.push({ path, branch: w.branch, removable: reason === null, reason, sessionId: who?.sessionId ?? null });
    }
    return { ok: true, rows };
  }

  async remove(projectId: unknown, rawPath: unknown): Promise<{ ok: true; branchKept: boolean } | { ok: false; error: string }> {
    const listed = await this.list(projectId);
    if (!listed.ok) return listed;
    const row = listed.rows.find((r) => r.path === rawPath);
    if (!row) return { ok: false, error: "That is not one of the agent's worktrees of this project." };
    if (!row.removable) return { ok: false, error: row.reason ?? "It cannot be removed." };
    const folder = this.deps.projectFolder(String(projectId))!;
    const who = (await this.readRecords())[row.path] ?? (await this.marker(row.path));
    if (who) {
      const moved = await this.deps.repoint(who.sessionId, existsSync(who.originalWorkingDir) ? who.originalWorkingDir : folder);
      if ("busy" in moved && moved.busy) return { ok: false, error: "Its chat is running a turn. Remove it when the turn ends." };
      /* The chat must leave the folder before it is deleted, or its next turn runs in a missing folder
         (the same three answers main.ts app:chooseWorkspace handles). Nothing is removed. */
      if ("error" in moved && moved.error) return { ok: false, error: `Its chat could not be moved back to the project's folder (${moved.error}), so the worktree was kept.` };
      if (moved.supported === false) return { ok: false, error: "Its chat could not be moved back to the project's folder: the agent is not reachable or is too old for that. The worktree was kept." };
    }
    const removed = await this.deps.git(["worktree", "remove", row.path], folder);
    if (!removed || removed.code !== 0) {
      const why = (removed?.stderr || "").trim().split("\n").at(-1) || "unknown error";
      return { ok: false, error: who
        ? `git worktree remove refused: ${why}. Its chat now works in the project's folder; the worktree and its branch are still there.`
        : `git worktree remove refused: ${why}` };
    }
    await this.deps.git(["worktree", "prune"], folder);
    const branch = row.branch ? await this.deps.git(["branch", "-d", row.branch], folder) : null;
    await rm(`${row.path}.json`, { force: true }).catch(() => {});
    await this.saveRecord(row.path, null);
    if (this.armed && (this.armed.dir === row.path || isInside(row.path, this.armed.dir))) this.armed = null;
    return { ok: true, branchKept: !!row.branch && (!branch || branch.code !== 0) };
  }

  private async dirty(path: string): Promise<string | null> {
    if (!existsSync(path)) return null;
    const st = await this.deps.git(["status", "--porcelain", "-z", "--untracked-files=normal", "--ignored=matching"], path);
    if (!st || st.code !== 0) return "git could not read it.";
    return dirtyReason(st.stdout);
  }

  /** The agent's own `<path>.json` marker (src/session/session-worktree.ts). */
  private async marker(path: string): Promise<WorktreeRecord | null> {
    try {
      const m = JSON.parse(await readFile(`${path}.json`, "utf8")) as Partial<WorktreeRecord>;
      return typeof m.sessionId === "string" && typeof m.originalWorkingDir === "string" ? { sessionId: m.sessionId, originalWorkingDir: m.originalWorkingDir } : null;
    } catch { return null; }
  }

  private async readRecords(): Promise<Record<string, WorktreeRecord>> {
    try {
      const v = JSON.parse(await readFile(recordsPath(this.deps.stateDir), "utf8")) as unknown;
      return v && typeof v === "object" ? (v as Record<string, WorktreeRecord>) : {};
    } catch { return {}; }
  }

  private async saveRecord(path: string, rec: WorktreeRecord | null): Promise<void> {
    const all = await this.readRecords();
    if (rec) all[path] = rec; else delete all[path];
    await mkdir(worktreesDir(this.deps.stateDir), { recursive: true });
    await writeFile(recordsPath(this.deps.stateDir), `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

/** git with no hooks, fsmonitor or prompts (git-safe-args.ts, ATO-2532); null when git cannot start. */
export function gitExecWith(env: () => NodeJS.ProcessEnv): GitExec {
  return (args, cwd) => new Promise((resolve) => {
    execFile("git", [...gitSafeArgs(), ...args],
      { cwd, env: { ...env(), GIT_PAGER: "", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(cwd)) { resolve({ code: 1, stdout: "", stderr: `${cwd} does not exist` }); return; }
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") { resolve(null); return; }
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

export function registerChatWorktreeIpc(ipcMain: Pick<IpcMain, "handle">, wt: ChatWorktrees): void {
  ipcMain.handle("worktree:newChat", (_e, projectId: unknown) => wt.start(projectId));
  ipcMain.handle("worktree:list", (_e, projectId: unknown) => wt.list(projectId));
  ipcMain.handle("worktree:remove", (_e, projectId: unknown, path: unknown) => wt.remove(projectId, path));
}
