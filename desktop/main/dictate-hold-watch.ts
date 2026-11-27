import { app } from "electron";
import { join } from "node:path";

import { HoldMachine, holdKeyCommand, type HoldAction, type HoldKeyLine, type HoldWatchState } from "./dictate-hold.js";
import { UiohookHoldWatcher } from "./hold-key-uiohook.js";
import { HoldKeyWatcher } from "./hold-key-watcher.js";

/**
 * The hold key for Dictate anywhere (ATO-1064), moved out of
 * dictate-anywhere-window.ts: the key's down/up through HoldMachine
 * (dictate-hold.ts), and the watcher that reports them. Windows:
 * uiohook-napi inside the app (loaded on the first start); the Mac: the Fn
 * helper process.
 */
export function holdKeyWatch(
  platform: NodeJS.Platform,
  log: (line: string) => void,
  onHold: (a: HoldAction) => void,
  onState: (st: HoldWatchState) => void,
): { hold: HoldMachine; watcher: UiohookHoldWatcher | HoldKeyWatcher } {
  const hold = new HoldMachine({ set: (ms, fn) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) }, onHold);
  const nativeDir = app.isPackaged ? join(process.resourcesPath, "native") : join(__dirname, "..", "native");
  const onKey = (line: HoldKeyLine) => {
    if (line.type === "down") hold.down();
    else if (line.type === "up") hold.up();
    else if (line.type === "esc") hold.esc();
    else if (line.type === "other") hold.other();
  };
  const onWatchState = (st: HoldWatchState) => {
    if (st !== "ready") hold.reset();
    if (st === "untrusted" || st === "missing" || st === "failed") log(`[desktop] dictate anywhere: hold key watcher ${st}`);
    onState(st);
  };
  const watcher = platform === "win32"
    ? new UiohookHoldWatcher(onKey, onWatchState, log)
    : new HoldKeyWatcher(() => holdKeyCommand(platform, nativeDir), onKey, onWatchState, log);
  return { hold, watcher };
}
