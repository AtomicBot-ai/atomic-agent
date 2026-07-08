import { ipcMain, type BrowserWindow } from "electron";

/**
 * Register window-control IPC handlers for the frameless main window.
 * The renderer's custom title bar invokes these to drive the OS window.
 * A `win.maximize-changed` event is pushed back so the UI can swap the
 * maximize/restore glyph.
 */
export function registerWindowControls(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.on("win.minimize", () => {
    getWindow()?.minimize();
  });

  ipcMain.on("win.toggle-maximize", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.on("win.close", () => {
    getWindow()?.close();
  });

  ipcMain.handle("win.is-maximized", () => getWindow()?.isMaximized() ?? false);
}

/**
 * Wire maximize/unmaximize events on a freshly created window so the
 * renderer can keep its title-bar glyph in sync.
 */
export function bindWindowMaximizeEvents(win: BrowserWindow): void {
  const push = (maximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send("win.maximize-changed", maximized);
    }
  };
  win.on("maximize", () => push(true));
  win.on("unmaximize", () => push(false));
}
