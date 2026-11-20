import { ipcMain } from "electron";

import { keystrokesAllowed, readSelectedText } from "./keystroke-clipboard-host.js";
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
export function wireSelectedText(w: { userData: string; platform: NodeJS.Platform }): { grabSelection: () => Promise<string | null> } {
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
        return await readSelectedText();
      } catch {
        return null;   // not permitted, no tool, a timeout: the mini chat opens without it
      }
    },
  };
}
