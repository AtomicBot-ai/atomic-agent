import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

import { petBounds, type PetPrefs } from "./pet-prefs.js";
import { quickEntryWindowLevel } from "./quick-entry.js";

/**
 * ATO-2391: the desktop pet's window (pet-ipc.ts drives it; the pure parts
 * are pet-events.ts, pet-state.ts and pet-prefs.ts). The pattern is the
 * marks overlay's (screen-overlay-window.ts):
 *
 * - transparent, frameless, no shadow, always on top and on every Space;
 * - `focusable: false` + `showInactive()`, a non-activating panel on macOS:
 *   it never takes the keyboard or the front from the app the person is in;
 * - click-through outside the sprite and the bubble: the window ignores the
 *   mouse and forwards moves, and the page says when the pointer is over
 *   something of its own (setHover). Linux forwards nothing, so there the
 *   window takes its clicks (it is small);
 * - `setContentProtection(true)`: the agent's own screenshots do not see it;
 * - dragged by the sprite: main follows the cursor while the page holds the
 *   button (dragStart / dragEnd), so a fast move never leaves it behind.
 *
 * The page uses the main window's preload (window.atomic.pet), as the
 * dictation pill and the mini chat do.
 */

const petWindows = new WeakSet<BrowserWindow>();

/** True for the pet: not "a window of the app" for the Dock reopen. */
export function isPetWindow(win: BrowserWindow): boolean {
  return petWindows.has(win);
}

const DRAG_TICK_MS = 16;
/** A drag whose end never came (the page went away) stops by itself. */
const DRAG_MAX_MS = 60_000;

export interface PetWindow {
  readonly win: BrowserWindow;
  send(channel: string, payload: unknown): void;
  setHover(inside: boolean): void;
  dragStart(): void;
  /** The drag is over; the window's top left, to be saved. */
  dragEnd(): { x: number; y: number } | null;
  close(): void;
}

export function openPetWindow(prefs: PetPrefs, platform: NodeJS.Platform, onClosed: () => void): PetWindow {
  const displays = screen.getAllDisplays().map((d) => ({ workArea: d.workArea }));
  const bounds = petBounds(prefs, displays, { workArea: screen.getPrimaryDisplay().workArea });
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "Atomic Agent Pet",
    ...(platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  petWindows.add(win);
  const forwards = platform === "darwin" || platform === "win32";
  if (forwards) win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, quickEntryWindowLevel(platform));
  if (platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => { if (!win.isDestroyed()) win.showInactive(); });

  let drag: { dx: number; dy: number; timer: NodeJS.Timeout; startedAt: number } | null = null;
  const stopDrag = () => {
    if (!drag) return;
    clearInterval(drag.timer);
    drag = null;
  };
  win.on("closed", () => {
    stopDrag();
    onClosed();
  });
  void win.loadFile(join(__dirname, "..", "renderer", "pet.html")).catch(() => {});

  return {
    win,
    send(channel, payload) {
      if (win.isDestroyed() || win.webContents.isLoading()) return;
      try { win.webContents.send(channel, payload); } catch { /* the page going away */ }
    },
    setHover(inside) {
      if (!forwards || win.isDestroyed() || drag) return;
      if (inside) win.setIgnoreMouseEvents(false);
      else win.setIgnoreMouseEvents(true, { forward: true });
    },
    dragStart() {
      if (win.isDestroyed() || drag) return;
      const cursor = screen.getCursorScreenPoint();
      const [x, y] = win.getPosition();
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (win.isDestroyed() || !drag || Date.now() - drag.startedAt > DRAG_MAX_MS) { stopDrag(); return; }
        const c = screen.getCursorScreenPoint();
        win.setPosition(Math.round(c.x - drag.dx), Math.round(c.y - drag.dy));
      }, DRAG_TICK_MS);
      drag = { dx: cursor.x - (x ?? 0), dy: cursor.y - (y ?? 0), timer, startedAt };
    },
    dragEnd() {
      const was = drag !== null;
      stopDrag();
      if (!was || win.isDestroyed()) return null;
      const [x, y] = win.getPosition();
      return typeof x === "number" && typeof y === "number" ? { x, y } : null;
    },
    close() {
      stopDrag();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
