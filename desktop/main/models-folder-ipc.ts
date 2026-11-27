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
 *   modelsFolder:cancel  stops a move under way, or one still waiting for its
 *                        turn; {ok}. The agent gets a "stop" line and puts
 *                        every model back, on Windows too
 *                        (models-folder-move.ts).
 *
 * The agent refuses while a local model runs or a background download goes;
 * a pull this window runs is refused here (`pulling`), since its partial
 * file sits in the folder being moved.
 *
 * ATO-2503: the move runs in the daemon's turn and under the config lock,
 * with a quiet-time limit and a cooperative Cancel: models-folder-move.ts.
 */

import { readdir } from "node:fs/promises";

import { dialog, ipcMain, type BrowserWindow } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun } from "./agent-cli.js";
import { folderListingIsEmpty, moveErrorWords, NOT_EMPTY_WORDS, parseModelsFolderInfo } from "./models-folder.js";
import { createModelsFolderMover, type ModelsFolderMoveAnswer } from "./models-folder-move.js";

export type { ModelsFolderMoveAnswer, ModelsFolderProgress } from "./models-folder-move.js";

export interface ModelsFolderIpcDeps {
  window: () => BrowserWindow | null;
  isRemote: () => boolean;
  /** main.ts: a model download this window runs. */
  pulling: () => boolean;
}

const REMOTE = "This app is connected to an agent on another computer: its models folder is set there.";

export function wireModelsFolderIpc(deps: ModelsFolderIpcDeps): void {
  const mover = createModelsFolderMover({
    send: (p) => deps.window()?.webContents.send("modelsFolder:progress", p),
  });

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
    if (mover.moving) return { ok: false, error: "The models are already being moved." };
    if (deps.pulling()) return { ok: false, error: "Wait for the model download to finish, then move the models." };
    const o = input && typeof input === "object" ? (input as { path?: unknown; reset?: unknown }) : {};
    const reset = o.reset === true;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    if (!reset && !path) return { ok: false, error: "Choose a folder first." };
    const binary = resolveBinary();
    if (!binary) return { ok: false, error: "The agent is not installed." };
    return mover.move(binary, reset ? ["models", "dir", "--reset"] : ["models", "dir", path]);
  });

  ipcMain.handle("modelsFolder:cancel", async () => mover.cancel());
}
