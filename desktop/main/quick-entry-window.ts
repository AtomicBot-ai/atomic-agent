import { BrowserWindow, clipboard, globalShortcut, ipcMain, Notification, screen } from "electron";
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
import { MINI_CHAT_SIZE, miniChatPagePath } from "./mini-chat.js";
import { activateApp, keystrokesAllowed, pasteIntoFrontApp } from "./keystroke-clipboard-host.js";
import { replaceInSourceApp, replaceLabel, replacementText, type SourceApp } from "./replace-selection.js";
import { selectionMissNotice, type SelectionGrab } from "./selected-text-grab.js";

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
 * its composer goes.
 *
 * ATO-1609: the window now loads the mini chat page (ATO-1063,
 * renderer/mini-chat.html) instead of the one-line box, the way ChatGPT's
 * companion window and Claude's quick entry work: the hotkey opens a small
 * chat that stays in front, the reply streams there, and "Open in big window"
 * moves it to the main window. The page keeps the unsent draft through
 * app:quickEntryOpened / app:quickEntryDraft as the box did. The same window
 * also opens from the menu (File › New Mini Chat) and the tray (`show`). The text waits here until the page takes it
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
  /** ATO-2478: the main window as it is, not brought up; null when it is closed. */
  mainWindow?: () => BrowserWindow | null;
  log: (line: string) => void;
  /** ATO-985: the text selected in the app in front, read before the mini chat window takes the keyboard (selected-text-ipc.ts). */
  grabSelection?: () => Promise<SelectionGrab>;
}

const quickWindows = new WeakSet<BrowserWindow>();

/** True for the quick-entry box: not "a window of the app" for the Dock reopen. */
export function isQuickEntryWindow(win: BrowserWindow): boolean {
  return quickWindows.has(win);
}

export function wireQuickEntry(w: QuickEntryWiring): { dispose: () => void; show: () => void } {
  let box: BrowserWindow | null = null;
  let draft = "";
  let pending: string | null = null;
  // ATO-2478: the waiting text goes to a new background chat, not the chat on screen.
  let pendingBackground = false;
  let selection: string | null = null;
  // ATO-2268: the app the selection came from, for "Replace in …" (macOS; null elsewhere).
  let source: SourceApp | null = null;
  // ATO-2736: why the hotkey brought no selection, as the mini chat's one line (null: nothing to say).
  let notice: { text: string; settings: boolean } | null = null;
  let opening = false;
  /* ATO-2750: true while Replace has the box out of sight and the source
     app in front. That switch blurs the box; the blur must not destroy it,
     or a failed paste has no window to come back to. */
  let replacing = false;
  let disposed = false;
  let pref: QuickEntryPref = readQuickEntryPref(w.userData);

  const hide = () => {
    const b = box;
    box = null;
    selection = null;
    source = null;
    notice = null;
    replacing = false;
    if (b && !b.isDestroyed()) b.destroy();
  };

  const open = () => {
    if (box && !box.isDestroyed()) {
      // A second press while it shows: the hotkey toggles, as Spotlight's does.
      hide();
      return;
    }
    if (opening) return;
    if (!w.grabSelection) { create(null); return; }
    /* ATO-985: the copy has to reach the app in front, so it runs before
       the box exists and takes the keyboard. */
    opening = true;
    void w.grabSelection().catch((): SelectionGrab => ({ selection: null, miss: "failed" })).then((grab) => {
      opening = false;
      if (!disposed) create(grab.selection, selectionMissNotice(grab.miss));
    });
  };

  const create = (sel: SelectionGrab["selection"], why: typeof notice = null) => {
    selection = sel ? sel.text : null;
    source = sel ? sel.app : null;
    notice = why;
    const cursor = screen.getCursorScreenPoint();
    const bounds = quickEntryBounds(cursor, screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea })), MINI_CHAT_SIZE);
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
      title: "Mini Chat",   // ATO-2750: the name the menu and the tray use (New Mini Chat)
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
    win.on("blur", () => { if (box === win && !replacing) hide(); });
    win.on("closed", () => { if (box === win) box = null; });
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    void win.loadFile(miniChatPagePath(__dirname)).catch(() => {});
  };
  // The menu and tray item: brings the window up, never toggles it away.
  const show = () => {
    if (box && !box.isDestroyed()) {
      box.show();
      box.focus();
      return;
    }
    /* ATO-985: no selected text from here. The app in front is this one
       (the menu) or the taskbar (the tray), not the one the user was in. */
    if (!opening) create(null);
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
  ipcMain.handle("app:quickEntryOpened", () => ({ draft, label: acceleratorLabel(pref.accelerator, w.platform), replace: source ? replaceLabel(source) : null, selection, notice }));
  /* ATO-2736: the line's button. Settings › General in the main window,
     where "Use selected text" and its Accessibility button are. */
  ipcMain.handle("app:quickEntryOpenSettings", (event) => {
    if (!box || box.isDestroyed() || event.sender !== box.webContents) return { ok: false };
    hide();
    const main = w.showMainWindow();
    if (!main || main.isDestroyed()) return { ok: false };
    const go = () => { if (!main.isDestroyed()) main.webContents.send("app:menu", "settings:general"); };
    if (main.webContents.isLoading()) main.webContents.once("did-finish-load", go);
    else go();
    return { ok: true };
  });
  ipcMain.on("app:quickEntryDraft", (_event, text: unknown) => { draft = typeof text === "string" ? text.slice(0, 20_000) : ""; });
  ipcMain.on("app:quickEntryHide", () => hide());
  /* ATO-2268: an answer put back in place of the selection, in the app it
     came from (replace-selection.ts). Only from the mini chat that has it. */
  ipcMain.handle("app:quickEntryReplace", (event, raw: unknown) => {
    if (!box || box.isDestroyed() || event.sender !== box.webContents) return { ok: false, hidden: false, error: "This window cannot replace text." };
    return replaceInSourceApp({
      allowed: (prompt) => keystrokesAllowed(prompt),
      /* ATO-2750: out of sight while the paste runs, not destroyed, so a
         failed paste brings it back with the line and "Copy answer". */
      hide: () => { replacing = true; if (box && !box.isDestroyed()) box.hide(); },
      bringBack: () => {
        replacing = false;
        if (!box || box.isDestroyed()) return false;
        box.show();
        box.focus();
        return true;
      },
      close: hide,
      activate: activateApp,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      paste: pasteIntoFrontApp,
      copy: (text) => clipboard.writeText(text),
      notify: (body) => {
        try { if (Notification.isSupported()) new Notification({ title: "Atomic Agent", body, silent: true }).show(); } catch { /* no notifications */ }
      },
    }, source, raw).finally(() => { replacing = false; });
  });
  // ATO-2750: "Copy answer" beside a failed Replace. Only from the mini chat.
  ipcMain.handle("app:quickEntryCopy", (event, raw: unknown) => {
    if (!box || box.isDestroyed() || event.sender !== box.webContents) return { ok: false };
    const text = replacementText(raw);
    if (!text) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle("app:quickEntrySubmit", (_event, raw: unknown) => {
    const text = quickEntryText(raw);
    if (!text) return { ok: false };
    draft = "";
    pending = text;
    pendingBackground = false;
    hide();
    const main = w.showMainWindow();
    if (!main || main.isDestroyed()) return { ok: false };
    // A page still loading has no listener yet; it takes the text when it is up.
    if (!main.webContents.isLoading()) main.webContents.send("app:quickEntry");
    return { ok: true };
  });
  /* ATO-2478: ⌘↩ in the mini chat. The text starts a new chat in the
     background in the main window (renderer/background-chat.js), which is
     not brought up: the person stays in the app they were in. Only a main
     window that is closed is opened again, since the chat runs there. */
  ipcMain.handle("app:quickEntryBackground", (event, raw: unknown) => {
    if (!box || box.isDestroyed() || event.sender !== box.webContents) return { ok: false };
    const text = quickEntryText(raw);
    if (!text) return { ok: false };
    draft = "";
    pending = text;
    pendingBackground = true;
    hide();
    const have = w.mainWindow ? w.mainWindow() : null;
    const main = have && !have.isDestroyed() ? have : w.showMainWindow();
    if (!main || main.isDestroyed()) return { ok: false };
    if (!main.webContents.isLoading()) main.webContents.send("app:quickEntry");
    return { ok: true };
  });
  // The main window's page: the text waiting, once.
  ipcMain.handle("app:quickEntryTake", () => {
    const text = pending;
    const background = pendingBackground;
    pending = null;
    pendingBackground = false;
    return text ? { text, background } : null;
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
      disposed = true;
      shortcut.dispose();
      hide();
    },
    show,
  };
}
