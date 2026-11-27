/**
 * ATO-2459: "Install" for a My apps app, a launcher in the OS app menu
 * that opens the app's own window through the desktop
 * (`atomicagent://app/open?id=<id>`, my-apps-deeplink.ts). Like Chrome's
 * "Install app" for a web page: one launcher per app, with an icon, in
 * the place the OS lists apps; Uninstall (and Delete) removes it.
 *
 *   macOS   ~/Applications/Atomic Apps/<name>.app   a tiny bundle whose
 *           launcher runs `/usr/bin/open <link>`; Launchpad and Spotlight
 *           list it
 *   Windows %APPDATA%\Microsoft\Windows\Start Menu\Programs\Atomic Apps\<name>.lnk
 *           written by Electron's shell.writeShortcutLink (the same
 *           IShellLink PowerShell's WScript.Shell reaches, without
 *           starting a PowerShell or quoting a script)
 *   Linux   ~/.local/share/applications/atomic-app-<id>.desktop
 *
 * The launcher is recorded in `<app>/install.json` as `{ path }`, which the
 * agent's `app.delete` also reads (src/tools/app/app-shortcut-paths.ts:
 * the folder and path rules below are a copy of it). A recorded path is
 * removed only when it sits directly in that folder with that extension.
 *
 * No Electron import: the unit suite loads it from `out/main`; Windows'
 * link writer is handed in.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { DEEPLINK_SCHEME } from "./deeplink.js";
import { appDir, isAppId, parseManifest, MY_APP_MANIFEST } from "./my-apps-store.js";

export const MY_APP_INSTALL_RECORD = "install.json";
export const MY_APP_SHORTCUT_FOLDER_NAME = "Atomic Apps";

export interface WindowsLink { target: string; args: string; description: string; icon: string; iconIndex: number }

export interface InstallHost {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  /** process.resourcesPath of a packaged app; null when unpackaged (no link handler is registered then). */
  resourcesPath: string | null;
  /** Windows only: Electron's shell.writeShortcutLink. */
  writeShortcutLink?: (path: string, operation: "create" | "replace", link: WindowsLink) => boolean;
  /** Test seam: makes the launcher folder (mkdirSync recursive). */
  ensureFolder?: (dir: string) => void;
}

export type InstallResult = { ok: true; path: string } | { ok: false; reason: "bad-id" | "not-found" | "install-unsupported" | "install-failed" };

/** The link a launcher opens. The id is a slug, so it needs no escaping anywhere it is written. */
export function appLaunchLink(id: string): string {
  return `${DEEPLINK_SCHEME}://app/open?id=${id}`;
}

export function appShortcutFolder(host: Pick<InstallHost, "platform" | "home" | "env">): string | null {
  const { platform, home, env } = host;
  if (platform === "darwin") return join(home, "Applications", MY_APP_SHORTCUT_FOLDER_NAME);
  if (platform === "win32") {
    const roaming = env.APPDATA && win32.isAbsolute(env.APPDATA) ? env.APPDATA : win32.join(home, "AppData", "Roaming");
    return win32.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", MY_APP_SHORTCUT_FOLDER_NAME);
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
    return join(data, "applications");
  }
  return null;
}

const EXT: Partial<Record<NodeJS.Platform, string>> = { darwin: ".app", win32: ".lnk", linux: ".desktop", freebsd: ".desktop", openbsd: ".desktop" };

export function isAppShortcutPath(path: unknown, id: string, host: Pick<InstallHost, "platform" | "home" | "env">): path is string {
  const folder = appShortcutFolder(host);
  const ext = EXT[host.platform];
  if (typeof path !== "string" || !folder || !ext) return false;
  const p = host.platform === "win32" ? win32 : { dirname, basename, resolve };
  const fold = (s: string) => (ext === ".desktop" ? s : s.toLowerCase());
  const full = p.resolve(path);
  if (fold(p.dirname(full)) !== fold(p.resolve(folder))) return false;
  const name = p.basename(full);
  if (!fold(name).endsWith(ext) || name.length <= ext.length) return false;
  return ext !== ".desktop" || name === `atomic-app-${id}.desktop`;
}

/** Whether Install can work here: a packaged app (its link handler is registered) on a platform with a launcher folder. */
export function installSupported(host: InstallHost): boolean {
  if (!host.resourcesPath || !appShortcutFolder(host)) return false;
  return host.platform !== "win32" || typeof host.writeShortcutLink === "function";
}

/** A launcher file name from the app's name: no path or reserved characters, at most 60, never empty. */
export function shortcutBaseName(name: string): string {
  let s = String(name || "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  s = Array.from(s).slice(0, 60).join("").replace(/[ .]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += " app";
  return s || "App";
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function macInfoPlist(name: string, id: string, hasIcon: boolean): string {
  const keys: Array<[string, string]> = [
    ["CFBundleName", name], ["CFBundleDisplayName", name], ["CFBundleIdentifier", `io.atomicagent.desktop.app.${id}`],
    ["CFBundleExecutable", "launch"], ["CFBundlePackageType", "APPL"], ["CFBundleVersion", "1"], ["CFBundleShortVersionString", "1.0"],
  ];
  if (hasIcon) keys.push(["CFBundleIconFile", "icon.icns"]);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + keys.map(([k, v]) => `  <key>${k}</key><string>${xml(v)}</string>\n`).join("")
    // No Dock icon of its own: the launcher hands the link over and quits at once.
    + "  <key>LSUIElement</key><true/>\n"
    + "</dict></plist>\n";
}

export function macLauncherScript(id: string): string {
  return `#!/bin/sh\nexec /usr/bin/open "${appLaunchLink(id)}"\n`;
}

/** One Exec argument, quoted as the Desktop Entry spec asks (and its string escapes on top). */
function execArg(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\\\\\").replace(/(["`$])/g, "\\\\$1").replace(/%/g, "%%") + '"';
}

export function linuxDesktopEntry(name: string, id: string, exec: string, icon: string | null): string {
  const value = (s: string) => s.replace(/\\/g, "\\\\").replace(/[\r\n\t]+/g, " ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${value(name)}`,
    "Comment=An app from Atomic Agent's My apps",
    `Exec=${execArg(exec)} ${execArg(appLaunchLink(id))}`,
    ...(icon ? [`Icon=${value(icon)}`] : []),
    "Terminal=false",
    "Categories=Utility;",
    "",
  ].join("\n");
}

function recordedPath(dir: string, id: string, host: InstallHost): string | null {
  try {
    const rec = JSON.parse(readFileSync(join(dir, MY_APP_INSTALL_RECORD), "utf8")) as { path?: unknown };
    return isAppShortcutPath(rec.path, id, host) ? rec.path : null;
  } catch { return null; }
}

/** The installed launcher, when its record is good and the file is still there. */
export function installedShortcut(host: InstallHost, root: string, id: unknown): string | null {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return null;
  const path = recordedPath(dir, id, host);
  return path && existsSync(path) ? path : null;
}

function writeLauncher(host: InstallHost, path: string, name: string, id: string): void {
  const res = host.resourcesPath as string;
  if (host.platform === "darwin") {
    const contents = join(path, "Contents");
    const icon = join(res, "app-icon.icns");
    const hasIcon = existsSync(icon);
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "Info.plist"), macInfoPlist(name, id, hasIcon), "utf8");
    writeFileSync(join(contents, "MacOS", "launch"), macLauncherScript(id), { encoding: "utf8", mode: 0o755 });
    if (hasIcon) copyFileSync(icon, join(contents, "Resources", "icon.icns"));
  } else if (host.platform === "win32") {
    const ok = host.writeShortcutLink!(path, existsSync(path) ? "replace" : "create", {
      target: host.execPath, args: appLaunchLink(id), description: `${name}, an app from Atomic Agent's My apps`, icon: host.execPath, iconIndex: 0,
    });
    if (!ok) throw new Error("shortcut not written");
  } else {
    const exec = host.env.APPIMAGE && host.env.APPIMAGE.trim() ? host.env.APPIMAGE : host.execPath;
    const icon = join(res, "app-icon.png");
    writeFileSync(path, linuxDesktopEntry(name, id, exec, existsSync(icon) ? icon : null), { encoding: "utf8", mode: 0o644 });
  }
}

/** Write (or rewrite, after a rename) the app's launcher and record it. */
export function installApp(host: InstallHost, root: string, id: unknown, now: number = Date.now()): InstallResult {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
  let manifest: ReturnType<typeof parseManifest>;
  try { manifest = parseManifest(readFileSync(join(dir, MY_APP_MANIFEST), "utf8"), id); } catch { manifest = null; }
  if (!manifest) return { ok: false, reason: "not-found" };
  const folder = appShortcutFolder(host);
  if (!installSupported(host) || !folder) return { ok: false, reason: "install-unsupported" };
  const ext = EXT[host.platform] as string;
  const join2 = host.platform === "win32" ? win32.join : join;
  const old = recordedPath(dir, id, host);
  let path: string;
  if (ext === ".desktop") path = join2(folder, `atomic-app-${id}.desktop`);
  else {
    const base = shortcutBaseName(manifest.name);
    path = join2(folder, base + ext);
    if (path !== old && existsSync(path)) path = join2(folder, `${base} ${id.slice(-6)}${ext}`);
  }
  try {
    if (old && old !== path) rmSync(old, { recursive: true, force: true });
    (host.ensureFolder ?? ((d: string) => { mkdirSync(d, { recursive: true }); }))(folder);
    if (host.platform === "darwin") rmSync(path, { recursive: true, force: true });
    writeLauncher(host, path, manifest.name, id);
    writeFileSync(join(dir, MY_APP_INSTALL_RECORD), JSON.stringify({ path, platform: host.platform, installedAt: new Date(now).toISOString() }, null, 2) + "\n");
  } catch {
    try { if (host.platform !== "win32") rmSync(path, { recursive: true, force: true }); } catch { /* nothing written */ }
    return { ok: false, reason: "install-failed" };
  }
  return { ok: true, path };
}

/** Remove the launcher and its record. An app that was not installed is fine. */
export function uninstallApp(host: InstallHost, root: string, id: unknown): { ok: true; removed: boolean } | { ok: false; reason: "bad-id" } {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
  const path = recordedPath(dir, id, host);
  let removed = false;
  if (path) {
    try { rmSync(path, { recursive: true, force: true }); removed = true; } catch { /* left; the record goes anyway */ }
  }
  try { rmSync(join(dir, MY_APP_INSTALL_RECORD), { force: true }); } catch { /* nothing recorded */ }
  return { ok: true, removed };
}
