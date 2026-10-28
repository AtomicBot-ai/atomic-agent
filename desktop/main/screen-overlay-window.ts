import { app, BrowserWindow, globalShortcut, screen } from "electron";
import { join } from "node:path";

import { ScreenMarksOverlay, type DisplayInfo, type LocalMark, type OverlayWindow } from "./screen-marks.js";

/**
 * The Electron half of ATO-1018 (screen-marks.ts holds the rest): one
 * transparent window per display that has marks, which never takes a
 * click, a key or the focus.
 *
 * - `focusable: false` + `showInactive()`, and on macOS `type: "panel"`
 *   (a non-activating NSPanel): showing it does not pull Atomic Agent to
 *   the front or take the key window from the app the person works in.
 * - `setIgnoreMouseEvents(true)`: every click goes to the app below.
 * - `setAlwaysOnTop(true, "screen-saver")` and every Space, full-screen
 *   apps included, so the marks are above the window they point into.
 * - `setContentProtection(true)`: the agent's next os.screen.capture does
 *   not see its own arrows and take them for the app's UI.
 * - Bounds are the display's bounds in DIP, which are points on macOS:
 *   the page draws in points and Retina needs no factor.
 */
function openOverlayWindow(display: DisplayInfo): OverlayWindow {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setContentProtection(true);
  // macOS may move a window under the menu bar on creation; put it back on the whole display.
  win.setBounds({ x, y, width, height });
  /* Nothing in the page may navigate or open windows. */
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  let pending: LocalMark[] | null = null;
  let loaded = false;
  const paint = (marks: LocalMark[]) => {
    if (win.isDestroyed()) return;
    // JSON is a JS literal; the page only reads it.
    void win.webContents
      .executeJavaScript(`window.__drawMarks(${JSON.stringify(marks)})`, false)
      .then(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
      })
      .catch(() => {});
  };
  win.webContents.once("did-finish-load", () => {
    loaded = true;
    if (pending) paint(pending);
    pending = null;
  });
  void win.loadFile(join(__dirname, "..", "renderer", "screen-overlay.html"));
  return {
    draw(marks) {
      if (loaded) paint(marks);
      else pending = marks;
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** The overlay with Electron's displays, cursor and Esc; cleared on display changes and quit. */
export function createScreenMarksOverlay(log: (line: string) => void): ScreenMarksOverlay {
  const overlay = new ScreenMarksOverlay({
    displays: () => screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds })),
    openWindow: openOverlayWindow,
    cursor: () => screen.getCursorScreenPoint(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    /* Esc is taken only while marks show, and given back the moment they go:
       the first Esc after the agent pointed clears the marks instead of
       reaching the app in front. */
    grabEscape: (onEscape) => {
      try {
        return globalShortcut.register("Escape", onEscape);
      } catch {
        return false;
      }
    },
    releaseEscape: () => {
      try {
        globalShortcut.unregister("Escape");
      } catch {
        /* already released */
      }
    },
    log,
  });
  const onDisplays = () => {
    if (overlay.showing) overlay.clear("displays");
  };
  screen.on("display-added", onDisplays);
  screen.on("display-removed", onDisplays);
  screen.on("display-metrics-changed", onDisplays);
  app.on("before-quit", () => overlay.clear("quit"));
  return overlay;
}
