import { ipcMain } from "electron";

import { keystrokesAllowed, readSelectedText } from "./keystroke-clipboard-host.js";
import { readFrontApp } from "./replace-front-app-host.js";   // ATO-2738: the window in front on Windows and Linux too
import { replaceAvailable } from "./replace-selection.js";
import { grabSelectionWith, type SelectionGrab } from "./selected-text-grab.js";
import {
  mergeSelectedTextPref,
  readSelectedTextPref,
  selectedTextInfo,
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
export type { GrabbedSelection, SelectionGrab } from "./selected-text-grab.js";

export function wireSelectedText(w: { userData: string; platform: NodeJS.Platform }): { grabSelection: () => Promise<SelectionGrab> } {
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
    /* ATO-2736: with the reason when nothing was read, for the mini chat's
       line (selected-text-grab.ts). Trust is asked each time, so a
       permission given since takes effect without a restart. */
    grabSelection: () => grabSelectionWith({
      pref,
      platform: w.platform,
      trusted: keystrokesAllowed(false),
      withFrontApp: replaceAvailable(w.platform),
      readText: readSelectedText,
      readFrontApp,
    }),
  };
}
