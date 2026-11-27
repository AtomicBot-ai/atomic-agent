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
 * The agent refuses while a local model runs or a background download goes;
 * a pull this window runs is refused here (`pulling`), since its partial
 * file sits in the folder being moved.
 */

import { spawn } from "node:child_process";

import { dialog, ipcMain, type BrowserWindow } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun, plainCliError, withConfigLock } from "./agent-cli.js";
import {
  leftoversFromStdout,
  movedToFromStdout,
  moveErrorWords,
  parseModelsFolderInfo,
  parseModelsMoveLine,
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

export function wireModelsFolderIpc(deps: ModelsFolderIpcDeps): void {
  let moving = false;

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
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, path: picked.filePaths[0] };
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
      return await withConfigLock(() => runMove(binary, reset ? ["models", "dir", "--reset"] : ["models", "dir", path], deps));
    } finally {
      moving = false;
    }
  });
}

function runMove(binary: string, args: string[], deps: ModelsFolderIpcDeps): Promise<ModelsFolderMoveAnswer> {
  const child = spawn(binary, args, { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const p = parseModelsMoveLine(line);
      if (p) deps.window()?.webContents.send("modelsFolder:progress", p);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      const dir = code === 0 && !err ? movedToFromStdout(stdout) : null;
      if (dir) { resolve({ ok: true, dir, leftovers: leftoversFromStdout(stdout) }); return; }
      resolve({ ok: false, error: err ? err.message : moveErrorWords(plainCliError(stderr), code) });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => finish(null, err));
  });
}
