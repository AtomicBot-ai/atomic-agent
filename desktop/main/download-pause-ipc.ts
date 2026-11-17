/**
 * ATO-1503: the window's Pause / Resume on a model download row
 * (renderer/dl-pause.js). The pull itself and its pause live in
 * download-pause.ts; this only answers the three calls.
 */
import type { IpcMain } from "electron";

import { pauseFrame, type PausablePull } from "./download-pause.js";

export interface PauseSlot {
  id: string;
  ctl?: PausablePull<unknown>;
}

export function registerDownloadPauseIpc(
  ipcMain: IpcMain,
  deps: { slot: () => PauseSlot | null; quitting: () => boolean },
): void {
  ipcMain.handle("cli:pullPauseState", () => {
    const s = deps.slot();
    return pauseFrame(s?.id ?? null, s?.ctl ? s.ctl.state() : null);
  });
  ipcMain.handle("cli:pausePull", (_event, id: unknown) => {
    const s = deps.slot();
    if (!s?.ctl || (typeof id === "string" && id !== s.id)) return { ok: false, error: "nothing to pause" };
    return s.ctl.pause() ? { ok: true } : { ok: false, error: "the download is not running" };
  });
  ipcMain.handle("cli:resumePull", (_event, id: unknown) => {
    if (deps.quitting()) return { ok: false, error: "the app is quitting" };
    const s = deps.slot();
    if (!s?.ctl || (typeof id === "string" && id !== s.id)) return { ok: false, error: "nothing to resume" };
    return s.ctl.resume() ? { ok: true } : { ok: false, error: "the download is not paused" };
  });
}
