/**
 * ATO-2534 / ATO-2526: the logbook's menu bar icon (macOS) or tray icon
 * (Windows, Linux), up while the logbook is on or paused, gone when it is
 * off. Its own icon, apart from Keep Running's (main.ts syncTray), so
 * turning either off leaves the other alone. The menu is
 * logbook-mark.ts logbookTrayItems: the state, Pause, Resume, Stop and
 * Open. While it is up it counts as the logbook's visible mark.
 *
 * Linux without a status area answers a blank icon or none: then there is
 * no icon, shown() is false, and only the chip in the window counts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from "electron";

import { logbookStateLine, logbookTrayItems, type LogbookAction, type LogbookChipView, type TrayItem } from "./logbook-mark.js";
import type { LogbookTrayHandle } from "./logbook-ipc.js";

export interface LogbookTrayDeps {
  act: (action: LogbookAction, minutes?: number) => void;
  openWindow: () => void;
  /** ATO-2526: the day timeline (renderer/logbook-timeline.js); no such item without it. */
  openTimeline?: () => void;
}

async function trayIcon(): Promise<NativeImage> {
  const bundled = app.isPackaged ? join(process.resourcesPath, "tray.png") : "";
  return bundled && existsSync(bundled)
    ? nativeImage.createFromPath(bundled)
    : await app.getFileIcon(process.execPath, { size: "small" }).catch(() => nativeImage.createEmpty());
}

function menuItem(item: TrayItem, deps: LogbookTrayDeps): MenuItemConstructorOptions {
  switch (item.kind) {
    case "label": return { label: item.label, enabled: false };
    case "separator": return { type: "separator" };
    case "action": return { label: item.label, click: () => deps.act(item.action, item.minutes) };
    case "open": return { label: item.label, click: () => (item.target === "timeline" ? deps.openTimeline?.() : deps.openWindow()) };
  }
}

export function createLogbookTray(deps: LogbookTrayDeps): LogbookTrayHandle & { destroy: () => void } {
  let tray: Tray | null = null;
  let wanted: LogbookChipView | null = null;
  let making = false;

  function draw(view: LogbookChipView): void {
    if (!tray) return;
    tray.setToolTip(logbookStateLine(view));
    if (process.platform === "darwin") tray.setTitle(view.state === "paused" ? "Logbook paused" : "● Logbook");
    const items = logbookTrayItems(view, { timeline: !!deps.openTimeline });
    tray.setContextMenu(Menu.buildFromTemplate(items.map((item) => menuItem(item, deps))));
  }

  function destroy(): void {
    tray?.destroy();
    tray = null;
  }

  async function sync(view: LogbookChipView | null): Promise<void> {
    wanted = view && view.state !== "off" ? view : null;
    if (!wanted) { destroy(); return; }
    if (tray) { draw(wanted); return; }
    if (making) return;
    making = true;
    try {
      const icon = await trayIcon();
      // Turned off while the icon was read, or no image to show.
      if (!wanted || tray) return;
      if (icon.isEmpty()) { console.error("[desktop] logbook: no tray icon on this system, the chip in the window is the only mark"); return; }
      tray = new Tray(icon.resize({ width: 16, height: 16 }));
      // Windows and Linux open the menu on a click too; macOS does by itself.
      if (process.platform !== "darwin") tray.on("click", () => tray?.popUpContextMenu());
      draw(wanted);
    } finally {
      making = false;
    }
  }

  app.on("will-quit", destroy);
  return { sync, shown: () => tray !== null, destroy };
}
