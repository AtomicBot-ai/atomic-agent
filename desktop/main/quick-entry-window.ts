import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { join } from "node:path";

import {
  acceleratorLabel,
  quickEntryBounds,
  quickEntrySkipReason,
  quickEntryStateLine,
  quickEntryText,
  quickEntryWindowLevel,
  QuickEntryShortcut,
  readQuickEntryPref,
  settleQuickEntrySet,
  writeQuickEntryPref,
  type QuickEntryPref,
} from "./quick-entry.js";

/**
 * The Electron half of ATO-523 (quick-entry.ts holds the rest).
 *
 * The box is created when the hotkey is pressed and destroyed when it hides,
 * never kept hidden: a hidden window would count as "a window of the app",
 * so closing the main window off macOS would no longer quit, and the Dock
 * click would not bring the main window back (main.ts window-all-closed,
 * activate). What was typed and not sent is kept here and put back next time.
 *
 * The box has no connection of its own: Enter hands the text to the main
 * window, which starts a new chat and sends it the way a message typed in
 * its composer goes. The text waits here until the page takes it
 * (`app:quickEntryTake`): `app:quickEntry` only says there is one, and a
 * page that was still loading asks once it is up, so nothing is lost to a
 * window opened again from closed and nothing is sent twice.
 */

export interface QuickEntryWiring {
  userData: string;
  platform: NodeJS.Platform;
  smoke: boolean;
  probe: boolean;
  modelsTest: boolean;
  /** Shows and focuses the main window, creating it again when it was closed. */
  showMainWindow: () => BrowserWindow | null;
  log: (line: string) => void;
}

const quickWindows = new WeakSet<BrowserWindow>();

/** True for the quick-entry box: not "a window of the app" for the Dock reopen. */
export function isQuickEntryWindow(win: BrowserWindow): boolean {
  return quickWindows.has(win);
}

export function wireQuickEntry(w: QuickEntryWiring): { dispose: () => void } {
  let box: BrowserWindow | null = null;
  let draft = "";
  let pending: string | null = null;
  let pref: QuickEntryPref = readQuickEntryPref(w.userData);

  const hide = () => {
    const b = box;
    box = null;
    if (b && !b.isDestroyed()) b.destroy();
  };

  const open = () => {
    if (box && !box.isDestroyed()) {
      // A second press while it shows: the hotkey toggles, as Spotlight's does.
      hide();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const bounds = quickEntryBounds(cursor, screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea })));
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#191C21",
      title: "Ask Atomic Agent",
      /* macOS: a panel takes the keyboard without bringing the app (and its
         main window) to the front, over full-screen apps too. */
      ...(w.platform === "darwin" ? { type: "panel" as const } : {}),
      webPreferences: {
        preload: join(__dirname, "..", "preload", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    });
    quickWindows.add(win);
    box = win;
    win.setAlwaysOnTop(true, quickEntryWindowLevel(w.platform));
    if (w.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // Clicking another app puts the box away; the typed text waits for next time.
    win.on("blur", () => { if (box === win) hide(); });
    win.on("closed", () => { if (box === win) box = null; });
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    void win.loadFile(join(__dirname, "..", "renderer", "quick-entry.html")).catch(() => {});
  };

  const shortcut = new QuickEntryShortcut(
    {
      register: (acc, cb) => globalShortcut.register(acc, cb),
      unregister: (acc) => globalShortcut.unregister(acc),
      isRegistered: (acc) => globalShortcut.isRegistered(acc),
    },
    open,
    quickEntrySkipReason({ smoke: w.smoke, probe: w.probe, modelsTest: w.modelsTest, envOff: process.env.ATOMIC_AGENT_NO_GLOBAL_SHORTCUT === "1" }),
  );

  const describe = () => {
    const st = shortcut.state();
    return {
      ok: true,
      enabled: pref.enabled,
      accelerator: pref.accelerator,
      label: acceleratorLabel(pref.accelerator, w.platform),
      state: st.state,
      error: quickEntryStateLine(st),
    };
  };

  const first = shortcut.apply(pref);
  if (first.state === "taken") w.log(`[desktop] quick entry: ${pref.accelerator} is taken by another app`);
  else if (first.state === "invalid") w.log(`[desktop] quick entry: ${pref.accelerator} cannot be used (${first.error})`);

  // The box's own page.
  ipcMain.handle("app:quickEntryOpened", () => ({ draft, label: acceleratorLabel(pref.accelerator, w.platform) }));
  ipcMain.on("app:quickEntryDraft", (_event, text: unknown) => { draft = typeof text === "string" ? text.slice(0, 20_000) : ""; });
  ipcMain.on("app:quickEntryHide", () => hide());
  ipcMain.handle("app:quickEntrySubmit", (_event, raw: unknown) => {
    const text = quickEntryText(raw);
    if (!text) return { ok: false };
    draft = "";
    pending = text;
    hide();
    const main = w.showMainWindow();
    if (!main || main.isDestroyed()) return { ok: false };
    // A page still loading has no listener yet; it takes the text when it is up.
    if (!main.webContents.isLoading()) main.webContents.send("app:quickEntry");
    return { ok: true };
  });
  // The main window's page: the text waiting, once.
  ipcMain.handle("app:quickEntryTake", () => {
    const text = pending;
    pending = null;
    return text ? { text } : null;
  });

  // Settings › General.
  ipcMain.handle("app:quickEntryGet", () => describe());
  ipcMain.handle("app:quickEntrySet", (_event, patch: unknown) => {
    const out = settleQuickEntrySet(pref, patch, shortcut, (p) => writeQuickEntryPref(w.userData, p));
    pref = out.pref;
    return out.ok ? describe() : { ...describe(), ok: false, error: out.error };
  });
  // While Settings records a new combo, the old one does not open the box.
  ipcMain.handle("app:quickEntryPause", (_event, paused: unknown) => {
    if (paused === true) shortcut.pause();
    else shortcut.apply(pref);
    return describe();
  });

  return {
    dispose: () => {
      shortcut.dispose();
      hide();
    },
  };
}
