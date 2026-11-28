import { ipcMain, shell } from "electron";

import { dictateFixUrl } from "./dictate-errors.js";
import type { DictatePill } from "./dictate-pill.js";
import { keystrokesAllowed } from "./keystroke-clipboard-host.js";

/**
 * The dictation pill page's routes (renderer/dictate-anywhere.js), moved
 * out of dictate-anywhere-window.ts, which owns the take:
 *
 *   app:dictateOpened     what the pill draws: the take's label, hint and
 *                         text, or (ATO-2750) a failure line and its button
 *   dictate:audio         a microphone chunk, from the pill only
 *   app:dictateStop       Done
 *   app:dictateCancel     ×, also on a failure pill
 *   app:dictateMicFailed  the page could not open the microphone: denied or not
 *   app:dictateFix        ATO-2750: the failure pill's button, the pane it names
 */

export interface DictatePillPage {
  platform: NodeJS.Platform;
  /** The take's part of app:dictateOpened. */
  opened: () => { label: string; hint: string; phase: string; text: string };
  audio: (chunk: unknown) => void;
  stop: () => void;
  cancel: () => void;
  /** The page could not open the microphone; `detail` is for the log only. */
  micFailed: (denied: boolean, detail: string | null) => void;
  /** Closes the pill (with the take's timers). */
  close: () => void;
}

export function wireDictatePillPage(pill: DictatePill, d: DictatePillPage): void {
  ipcMain.handle("app:dictateOpened", () => {
    // ATO-2750: a failure pill draws its line and button instead of opening the microphone.
    const failed = pill.failure ? { line: pill.failure.line, fixLabel: pill.failure.fixLabel } : null;
    return { ...d.opened(), failure: failed };
  });
  ipcMain.on("dictate:audio", (event, chunk: unknown) => { if (pill.isPage(event.sender)) d.audio(chunk); });
  ipcMain.on("app:dictateStop", (event) => { if (pill.isPage(event.sender)) d.stop(); });
  ipcMain.on("app:dictateCancel", () => d.cancel());
  ipcMain.on("app:dictateMicFailed", (event, why: unknown) => {
    if (!pill.isPage(event.sender) || pill.failure) return;
    const r = why && typeof why === "object" ? (why as { denied?: unknown; detail?: unknown }) : {};
    d.micFailed(r.denied === true, typeof r.detail === "string" ? r.detail.slice(0, 200) : null);
  });
  ipcMain.handle("app:dictateFix", async (event) => {
    if (!pill.isPage(event.sender) || !pill.failure || !pill.failure.fix) return { ok: false };
    const fix = pill.failure.fix;
    d.close();
    if (fix === "accessibility") keystrokesAllowed(true);   // puts Atomic Agent in the Accessibility list
    const url = dictateFixUrl(fix, d.platform);
    if (url) await shell.openExternal(url).catch(() => {});
    return { ok: !!url };
  });
}
