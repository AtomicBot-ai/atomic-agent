/**
 * ATO-2459: where an installed My apps app's OS shortcut lives, and its
 * removal. The desktop's Install (desktop/main/my-apps-install.ts) writes
 * the shortcut and records it in `<app>/install.json` as `{ path }`; an
 * app deleted from a chat (`app.delete`) takes its shortcut with it, so
 * no launcher is left pointing at nothing. Like Chrome's "Install app":
 * one launcher per app in the OS app menu.
 *
 *   macOS   ~/Applications/Atomic Apps/<name>.app
 *   Windows %APPDATA%\Microsoft\Windows\Start Menu\Programs\Atomic Apps\<name>.lnk
 *   Linux   $XDG_DATA_HOME/applications/atomic-app-<id>.desktop (~/.local/share)
 *
 * A recorded path is removed only when it sits directly in that folder
 * with that extension: a hand-edited install.json cannot point the
 * removal at anything else.
 */

import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

export const APP_INSTALL_RECORD = "install.json";
export const APP_SHORTCUT_FOLDER_NAME = "Atomic Apps";

export interface ShortcutPlace {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** The folder this platform's launchers go in, or null where there is none. */
export function appShortcutFolder(place: ShortcutPlace): string | null {
  const { platform, home, env } = place;
  if (platform === "darwin") return join(home, "Applications", APP_SHORTCUT_FOLDER_NAME);
  if (platform === "win32") {
    const roaming = env.APPDATA && win32.isAbsolute(env.APPDATA) ? env.APPDATA : win32.join(home, "AppData", "Roaming");
    return win32.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", APP_SHORTCUT_FOLDER_NAME);
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
    return join(data, "applications");
  }
  return null;
}

const SHORTCUT_EXT: Partial<Record<NodeJS.Platform, string>> = {
  darwin: ".app",
  win32: ".lnk",
  linux: ".desktop",
  freebsd: ".desktop",
  openbsd: ".desktop",
};

/** Whether `path` is a launcher this feature may have written for app `id`. */
export function isAppShortcutPath(path: unknown, id: string, place: ShortcutPlace): path is string {
  const folder = appShortcutFolder(place);
  const ext = SHORTCUT_EXT[place.platform];
  if (typeof path !== "string" || !folder || !ext) return false;
  const p = place.platform === "win32" ? win32 : { dirname, basename, resolve };
  // Windows and macOS folders ignore case; Linux ones do not.
  const fold = (s: string) => (ext === ".desktop" ? s : s.toLowerCase());
  const full = p.resolve(path);
  if (fold(p.dirname(full)) !== fold(p.resolve(folder))) return false;
  const name = p.basename(full);
  if (!fold(name).endsWith(ext) || name.length <= ext.length) return false;
  // On Linux the file is named after the id, so another app's launcher is never taken.
  return ext !== ".desktop" || name === `atomic-app-${id}.desktop`;
}

/** The recorded launcher path, or null (not installed, or a record that is not one). */
export function readAppShortcut(appFolder: string, id: string, place: ShortcutPlace): string | null {
  try {
    const rec = JSON.parse(readFileSync(join(appFolder, APP_INSTALL_RECORD), "utf8")) as { path?: unknown };
    return isAppShortcutPath(rec.path, id, place) ? rec.path : null;
  } catch {
    return null;
  }
}

/** Remove the app's launcher and its record. True when a launcher was removed. */
export function removeAppShortcut(appFolder: string, id: string, place: ShortcutPlace): boolean {
  const path = readAppShortcut(appFolder, id, place);
  let removed = false;
  if (path) {
    try {
      rmSync(path, { recursive: true, force: true });
      removed = true;
    } catch {
      /* a launcher that will not go is left; the record goes either way */
    }
  }
  try {
    rmSync(join(appFolder, APP_INSTALL_RECORD), { force: true });
  } catch {
    /* nothing recorded */
  }
  return removed;
}
