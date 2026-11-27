import { existsSync } from "node:fs";
import { join } from "node:path";
import { Menu, Tray, app, nativeImage, type NativeImage } from "electron";

/**
 * ATO-2401 "Show once": the menu bar item that is up for exactly as long
 * as a recording runs ("● Recording steps"). One click stops and saves;
 * the right-click menu also discards. Throws when it cannot be shown, and
 * then nothing records (show-once-start.ts). Split out of show-once-ipc.ts.
 *
 * ATO-2499 Windows and Linux: a tray icon has no title there, so it is the
 * app's own icon (resources/tray.png, as main.ts syncTray) with the same
 * words as its tooltip, and its menu holds Stop and Discard (on Linux a
 * click opens the menu; Windows also stops on a click). No icon, no tray.
 */
function trayIcon(): NativeImage {
  if (process.platform === "darwin") return nativeImage.createEmpty();
  const file = app.isPackaged ? join(process.resourcesPath, "tray.png") : join(__dirname, "..", "..", "build", "icons", "32x32.png");
  const icon = existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  if (icon.isEmpty()) throw new Error("no tray icon on this system");
  return icon.resize({ width: 16, height: 16 });
}

export function showOnceTray(stop: () => void, discard: () => void): Tray {
  const t = new Tray(trayIcon());
  try {
    const menu = () => Menu.buildFromTemplate([
      { label: "Stop and save as a skill draft", click: stop },
      { label: "Discard this recording", click: discard },
    ]);
    if (process.platform === "darwin") {
      t.setTitle(" ● Recording steps");
      t.on("right-click", () => t.popUpContextMenu(menu()));
    } else {
      t.setToolTip("● Recording steps. Click to stop and save.");
      t.setContextMenu(menu());
    }
    t.on("click", stop);
  } catch (err) {
    try { t.destroy(); } catch { /* gone */ }
    throw err;
  }
  return t;
}
