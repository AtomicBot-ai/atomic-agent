import { ipcMain } from "electron";

import { keystrokesAllowed, readSelectedText } from "./keystroke-clipboard-host.js";
import { readFrontApp } from "./replace-front-app-host.js";   // ATO-2738: the window in front on Windows and Linux too
import { replaceAvailable, type SourceApp } from "./replace-selection.js";
import {
  mergeSelectedTextPref,
  readSelectedTextPref,
  selectedTextInfo,
  selectedTextInUse,
  writeSelectedTextPref,
  type SelectedTextPref,
} from "./selected-text.js";

/**
 * ATO-985, the Electron half: Settings › General's "Use selected text"
 * switch, the language the mini chat's Translate picker saves (the same
 * app:selectedTextSet with {translateTo}), and the read the hotkey asks
 * for before the mini chat window opens (quick-entry-window.ts
 * `grabSelection`).
 */
/** The selection the hotkey read, and (ATO-2268, macOS) the app it came from, for "Replace in …". */
export interface GrabbedSelection {
  text: string;
  app: SourceApp | null;
}

export function wireSelectedText(w: { userData: string; platform: NodeJS.Platform }): { grabSelection: () => Promise<GrabbedSelection | null> } {
  let pref: SelectedTextPref = readSelectedTextPref(w.userData);
  const describe = () => selectedTextInfo(pref, w.platform, keystrokesAllowed(false));

  ipcMain.handle("app:selectedTextGet", () => describe());
  ipcMain.handle("app:selectedTextSet", (_event, patch: unknown) => {
    const merged = mergeSelectedTextPref(pref, patch);
    if (!merged.ok) return { ...describe(), ok: false, error: merged.error };
    // Turned on by the user without the permission: macOS's own request, once (not on a language pick).
    const turnedOn = merged.pref.use === true && pref.use !== true;
    if (turnedOn && w.platform === "darwin" && !keystrokesAllowed(false)) keystrokesAllowed(true);
    if (!writeSelectedTextPref(w.userData, merged.pref)) return { ...describe(), ok: false, error: "The setting could not be saved." };
    pref = merged.pref;
    return describe();
  });

  return {
    grabSelection: async () => {
      if (!selectedTextInUse(pref, w.platform, keystrokesAllowed(false))) return null;
      try {
        /* ATO-2268: the app in front is read beside the copy (the copy does
           not change which app is in front), so "Replace in …" knows where
           to put the answer back. It never holds the selection back. */
        const front = replaceAvailable(w.platform) ? readFrontApp().catch(() => null) : Promise.resolve(null);
        const [text, app] = await Promise.all([readSelectedText(), front]);
        return text ? { text, app } : null;
      } catch {
        return null;   // not permitted, no tool, a timeout: the mini chat opens without it
      }
    },
  };
}
