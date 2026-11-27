/**
 * ATO-2106: the routes behind Settings › Models › "Models folder"
 * (renderer/models-folder.js). The agent moves the files and writes the
 * config (`atag models dir`, src/cli/models-dir-command.ts); this only asks
 * where they are, lets the person pick a folder, runs the move and relays
 * its progress. Same shape as LM Studio's My Models › Models Directory ›
 * Change, which moves the models and points the app at the new folder.
 *
 *   modelsFolder:info    {ok, dir, defaultDir, custom} from `models dir --json`.
 *   modelsFolder:choose  the folder dialog; {ok, path} or {ok:false, cancelled}.
 *   modelsFolder:move    {path} or {reset:true}: runs `models dir <path>` (or
 *                        `--reset`) under the config lock, as every config
 *                        write here is. Progress goes to the window as
 *                        `modelsFolder:progress` {entry, index, total}.
 *
 *   modelsFolder:cancel  stops a move under way (SIGTERM: the agent puts every
 *                        model back); {ok}.
 *
 * The agent refuses while a local model runs or a background download goes;
 * a pull this window runs is refused here (`pulling`), since its partial
 * file sits in the folder being moved.
 *
 * ATO-2503: the move runs in the daemon's turn (backend-switch inDaemonTurn),
 * as the llama.cpp update does, so no Start, launch start or supervisor
 * restart begins while models are copied, and the agent's own marker
 * refuses any that would. Progress carries bytes across disks. A move quiet
 * for MOVE_QUIET_LIMIT_MS is stopped (SIGTERM, then SIGKILL), so a disk that
 * stops answering cannot hold the config lock and the daemon's turn for ever.
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

import { dialog, ipcMain, type BrowserWindow } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun, plainCliError, withConfigLock } from "./agent-cli.js";
import { inDaemonTurn } from "./backend-switch.js";
import {
  folderListingIsEmpty,
  leftoversFromStdout,
  movedToFromStdout,
  MOVE_HUNG_WORDS,
  MOVE_KILL_GRACE_MS,
  MOVE_QUIET_LIMIT_MS,
  moveErrorWords,
  NOT_EMPTY_WORDS,
  parseModelsFolderInfo,
  parseModelsMoveBytes,
  parseModelsMoveLine,
  type ModelsMoveProgress,
} from "./models-folder.js";
import { agentEnv } from "./state-dir.js";

export interface ModelsFolderMoveAnswer {
  ok: boolean;
  dir?: string;
  leftovers?: string[];
  error?: string;
}

export interface ModelsFolderIpcDeps {
  window: () => BrowserWindow | null;
  isRemote: () => boolean;
  /** main.ts: a model download this window runs. */
  pulling: () => boolean;
}

const REMOTE = "This app is connected to an agent on another computer: its models folder is set there.";

const CLOSED: ModelsFolderMoveAnswer = { ok: false, error: "The app is closing; the models were not moved." };

export function wireModelsFolderIpc(deps: ModelsFolderIpcDeps): void {
  let moving = false;
  let stopMove: (() => void) | null = null;

  ipcMain.handle("modelsFolder:info", async () => {
    if (deps.isRemote()) return { ok: false, error: REMOTE };
    const res = await atagRun(["models", "dir", "--json"], 15_000).catch(() => null);
    const info = res && res.ok ? parseModelsFolderInfo(res.stdout) : null;
    return info ? { ok: true, ...info } : { ok: false, error: res ? moveErrorWords(res.stderr, null) : "Could not ask the agent." };
  });

  ipcMain.handle("modelsFolder:choose", async () => {
    const win = deps.window();
    const opts = {
      title: "Choose a folder for your models",
      buttonLabel: "Use this folder",
      message: "Pick an empty folder, or make a new one. Only the models move there.",
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return { ok: false, cancelled: true };
    // The agent refuses a non-empty folder as well; saying so here keeps the
    // person in the dialog flow instead of after a failed move.
    const names = await readdir(path).catch(() => [] as string[]);
    if (!folderListingIsEmpty(names)) return { ok: false, error: NOT_EMPTY_WORDS };
    return { ok: true, path };
  });

  ipcMain.handle("modelsFolder:move", async (_event, input: unknown): Promise<ModelsFolderMoveAnswer> => {
    if (deps.isRemote()) return { ok: false, error: REMOTE };
    if (moving) return { ok: false, error: "The models are already being moved." };
    if (deps.pulling()) return { ok: false, error: "Wait for the model download to finish, then move the models." };
    const o = input && typeof input === "object" ? (input as { path?: unknown; reset?: unknown }) : {};
    const reset = o.reset === true;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    if (!reset && !path) return { ok: false, error: "Choose a folder first." };
    const binary = resolveBinary();
    if (!binary) return { ok: false, error: "The agent is not installed." };
    moving = true;
    try {
      const args = reset ? ["models", "dir", "--reset"] : ["models", "dir", path];
      return await inDaemonTurn(
        () => withConfigLock(() => runMove(binary, args, deps, (stop) => { stopMove = stop; })),
        () => CLOSED,
      );
    } finally {
      moving = false;
      stopMove = null;
    }
  });

  ipcMain.handle("modelsFolder:cancel", async () => {
    if (!stopMove) return { ok: false, error: "No move is under way." };
    stopMove();
    return { ok: true };
  });
}

/** What the window hears while a move runs: the model, and bytes across disks. */
export type ModelsFolderProgress = ModelsMoveProgress & { done?: number; size?: number };

interface RunMoveTimers {
  quietMs?: number;
  graceMs?: number;
}

/** Run `atag models dir ...` and answer how it went; `onStop` hands out the stop for Cancel. */
function runMove(
  binary: string,
  args: string[],
  deps: Pick<ModelsFolderIpcDeps, "window">,
  onStop: (stop: () => void) => void = () => {},
  timers: RunMoveTimers = {},
): Promise<ModelsFolderMoveAnswer> {
  const quietMs = timers.quietMs ?? MOVE_QUIET_LIMIT_MS;
  const graceMs = timers.graceMs ?? MOVE_KILL_GRACE_MS;
  const child = spawn(binary, args, { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let partial = "";
  let last: ModelsMoveProgress | null = null;
  let hung = false;
  let quiet: NodeJS.Timeout | null = null;
  let kill: NodeJS.Timeout | null = null;
  const send = (p: ModelsFolderProgress) => deps.window()?.webContents.send("modelsFolder:progress", p);
  const stop = () => {
    if (kill || child.exitCode !== null) return;
    child.kill("SIGTERM");
    kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, graceMs);
    kill.unref?.();
  };
  const heard = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => { hung = true; stop(); }, quietMs);
    quiet.unref?.();
  };
  onStop(stop);
  heard();
  child.stdout?.on("data", (chunk: Buffer) => {
    heard();
    const text = chunk.toString("utf8");
    stdout += text;
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const p = parseModelsMoveLine(line);
      if (p) { last = p; send(p); continue; }
      const b = parseModelsMoveBytes(line);
      if (b && last) send({ ...last, entry: b.entry, done: b.done, size: b.size });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { heard(); stderr += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (quiet) clearTimeout(quiet);
      if (kill) clearTimeout(kill);
      const dir = code === 0 && !err ? movedToFromStdout(stdout) : null;
      if (dir) { resolve({ ok: true, dir, leftovers: leftoversFromStdout(stdout) }); return; }
      if (hung) { resolve({ ok: false, error: MOVE_HUNG_WORDS }); return; }
      // A Cancel the agent did not get to answer (SIGKILL, or Windows, where a kill is immediate).
      if (kill && !/the move was stopped/.test(stderr)) {
        resolve({ ok: false, error: "The move was stopped. Your models are still in the old folder; a partly copied model may be left in the new one." });
        return;
      }
      resolve({ ok: false, error: err ? "Could not run the agent to move the models." : moveErrorWords(plainCliError(stderr), code) });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => finish(null, err));
  });
}
