import { Menu, Tray, nativeImage } from "electron";

/**
 * ATO-2401 "Show once": the menu bar item that is up for exactly as long
 * as a recording runs ("● Recording steps"). One click stops and saves;
 * the right-click menu also discards. Throws when it cannot be shown, and
 * then nothing records (show-once-start.ts). Split out of show-once-ipc.ts.
 */
export function showOnceTray(stop: () => void, discard: () => void): Tray {
  const t = new Tray(nativeImage.createEmpty());
  try {
    t.setTitle(" ● Recording steps");
    t.on("click", stop);
    t.on("right-click", () => {
      t.popUpContextMenu(Menu.buildFromTemplate([
        { label: "Stop and save as a skill draft", click: stop },
        { label: "Discard this recording", click: discard },
      ]));
    });
  } catch (err) {
    try { t.destroy(); } catch { /* gone */ }
    throw err;
  }
  return t;
}
