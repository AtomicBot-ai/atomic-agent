/**
 * ATO-598 (G-64) — keep running in the tray after the window closes, and
 * start at login.
 *
 * On Windows and Linux closing the window quit the app, and the agent with
 * it: a scheduled task or a Telegram bot stopped answering the moment the
 * window went away. Both are opt-in, from the Agent menu, and off by
 * default, so nothing changes for anyone who does not ask:
 *
 *   - Keep Running After the Window Closes: closing the last window leaves
 *     the app (and `atag serve`) running with an icon in the tray / menu
 *     bar; its menu opens the window again or quits.
 *   - Start at Login: `app.setLoginItemSettings` on macOS and Windows; on
 *     Linux a `.desktop` file in `~/.config/autostart`.
 *
 * The choice lives in userData (background.json): it is about this
 * computer, not the agent's settings shared with the terminal.
 *
 * Pure apart from the file and the platform calls handed in.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BackgroundPrefs {
  keepRunning: boolean;
}

export function readBackgroundPrefs(userData: string): BackgroundPrefs {
  try {
    const raw = JSON.parse(readFileSync(join(userData, "background.json"), "utf8")) as Partial<BackgroundPrefs>;
    return { keepRunning: raw.keepRunning === true };
  } catch {
    return { keepRunning: false };
  }
}

export function writeBackgroundPrefs(userData: string, prefs: BackgroundPrefs): void {
  try {
    writeFileSync(join(userData, "background.json"), `${JSON.stringify(prefs)}\n`, "utf8");
  } catch {
    /* a read-only userData keeps the default: close quits off macOS */
  }
}

/** Whether closing the last window quits the app (window-all-closed). */
export function quitsOnLastWindow(platform: NodeJS.Platform, prefs: BackgroundPrefs): boolean {
  return platform !== "darwin" && !prefs.keepRunning;
}

/* ---- start at login ---- */

/** Where Linux desktops look for autostart entries (XDG). */
export function linuxAutostartFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "autostart", "atomic-agent.desktop");
}

/** The autostart entry for the running app: an AppImage is started by its own path, not the mounted binary. */
export function linuxAutostartEntry(execPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const exec = env.APPIMAGE && env.APPIMAGE.trim() ? env.APPIMAGE : execPath;
  const quoted = /[\s"\\]/.test(exec) ? `"${exec.replace(/(["\\])/g, "\\$1")}"` : exec;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Atomic Agent",
    `Exec=${quoted}`,
    "X-GNOME-Autostart-enabled=true",
    "Terminal=false",
    "",
  ].join("\n");
}

export interface LoginItemHost {
  platform: NodeJS.Platform;
  execPath: string;
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export function startsAtLogin(host: LoginItemHost): boolean {
  if (host.platform === "linux") return existsSync(linuxAutostartFile());
  try {
    return host.getLoginItemSettings().openAtLogin === true;
  } catch {
    return false;
  }
}

export function setStartAtLogin(host: LoginItemHost, on: boolean): boolean {
  try {
    if (host.platform === "linux") {
      const file = linuxAutostartFile();
      if (on) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, linuxAutostartEntry(host.execPath), "utf8");
      } else {
        rmSync(file, { force: true });
      }
    } else {
      host.setLoginItemSettings({ openAtLogin: on });
    }
    return startsAtLogin(host) === on;
  } catch {
    return false;
  }
}
