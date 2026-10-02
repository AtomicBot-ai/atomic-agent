/**
 * Chat review Д23: a path named in a reply, offered as a file to open.
 *
 * A reply is the model's text, and anything it read can put a path in it, so
 * the window turns a path into a button only when it is a file or a folder
 * that exists inside the person's home folder: written `~/…` or absolute,
 * never a URL, with `..` and symlinks resolved before the home check, and
 * nothing outside the home folder touched to find out. Opening one never runs
 * anything: an app, a script, an installer, a link file, a Finder alias, or an
 * extensionless file with an execute bit (which macOS hands to Terminal) is
 * shown in the file manager instead of being opened — judged on the real path
 * a symlink leads to, which is the one that opens.
 *
 * Pure but for the file system reads: no Electron import, so the unit suite
 * loads it from `out/main` and drives it against a throwaway "home".
 */

import type { Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";

import { expandHome, isAbsoluteOn, isUnder, pathFor, type Platform } from "./platform.js";

export type ReplyPath = {
  /** The path as the reply wrote it. */
  path: string;
  /** The real path it names (symlinks resolved), or null when it is not offered. */
  abs: string | null;
  ok: boolean;
  kind: "file" | "dir" | null;
  /** Shown in the file manager rather than opened: opening it would run something. */
  reveal: boolean;
  /** Why it is not offered. */
  why?: "not-a-path" | "outside-home" | "missing" | "not-a-file";
};

/** Files the system runs, installs or follows rather than shows, on any of the three platforms. */
const RUNS = new Set([
  // macOS
  ".command", ".tool", ".terminal", ".pkg", ".mpkg", ".dmg", ".scpt", ".scptd", ".applescript",
  ".webloc", ".inetloc", ".fileloc", ".jar",
  // scripts
  ".sh", ".bash", ".zsh", ".csh", ".tcsh", ".ksh", ".fish", ".py", ".pyw", ".pyc", ".rb", ".pl", ".php", ".lua", ".tcl",
  // Windows
  ".exe", ".bat", ".cmd", ".com", ".msi", ".msp", ".msu", ".msix", ".msixbundle", ".appx", ".appxbundle", ".appinstaller",
  ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".ws", ".wsc", ".wsf", ".wsh", ".hta", ".scr", ".lnk", ".url",
  ".website", ".reg", ".cpl", ".msc", ".pif", ".scf", ".appref-ms", ".application", ".gadget", ".inf", ".sct",
  ".shb", ".shs", ".chm", ".diagcab", ".jnlp",
  // Linux
  ".desktop", ".run", ".bin", ".appimage", ".deb", ".rpm", ".snap", ".flatpakref",
]);
/** Folders macOS treats as one runnable or installable thing. */
const BUNDLES = new Set([
  ".app", ".bundle", ".framework", ".plugin", ".prefpane", ".kext", ".appex", ".xpc", ".systemextension",
  ".workflow", ".action", ".saver", ".qlgenerator", ".mdimporter",
]);

/** Would opening this run something? `mode` is the stat's; an execute bit counts only without an extension. */
export function runsWhenOpened(platform: Platform, p: string, kind: "file" | "dir", mode: number): boolean {
  const ext = pathFor(platform).extname(p).toLowerCase();
  // A folder can be an installer too (a flat-folder .pkg or .mpkg).
  if (kind === "dir") return BUNDLES.has(ext) || RUNS.has(ext);
  if (RUNS.has(ext)) return true;
  return platform !== "win32" && ext === "" && (mode & 0o111) !== 0;
}

/** A Finder alias: a bookmark file (`book␀␀␀␀mark…`), which realpath leaves as it
    is and macOS follows when it is opened — to whatever it names. */
export async function isFinderAlias(p: string): Promise<boolean> {
  const fh = await open(p, "r").catch(() => null);
  if (!fh) return false;
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    return bytesRead === 12 && head.toString("latin1", 0, 4) === "book" && head.toString("latin1", 8, 12) === "mark";
  } catch {
    return false;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The real path behind `p` (symlinks resolved), what it is, and whether
    opening it would run something; null when there is nothing there. */
export async function openTarget(p: string, platform: Platform): Promise<{ real: string; kind: "file" | "dir"; reveal: boolean } | null> {
  const real = await realpath(p).catch(() => null);
  if (!real) return null;
  const st: Stats | null = await stat(real).catch(() => null);
  const kind = !st ? null : st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  if (!st || !kind) return null;
  const reveal = runsWhenOpened(platform, real, kind, st.mode)
    || (platform === "darwin" && kind === "file" && await isFinderAlias(real));
  return { real, kind, reveal };
}

const no = (path: string, why: NonNullable<ReplyPath["why"]>): ReplyPath =>
  ({ path, abs: null, ok: false, kind: null, reveal: false, why });

/** What the window may do with a path a reply names, against `home`. */
export async function replyPathVerdict(raw: unknown, home: string, platform: Platform): Promise<ReplyPath> {
  if (typeof raw !== "string") return no("", "not-a-path");
  const path = raw;
  if (!path || path.length > 4096 || /[\0\r\n]/.test(path)) return no(path, "not-a-path");
  // A URL, a file: URL, or a Windows network path is never a file to open from here.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) || /^file:/i.test(path)) return no(path, "not-a-path");
  if (platform === "win32" && /^[\\/]{2}/.test(path)) return no(path, "not-a-path");
  const expanded = path === "~" ? home : expandHome(platform, path, home);
  if (!isAbsoluteOn(platform, expanded)) return no(path, "not-a-path");
  const P = pathFor(platform);
  const realHome = await realpath(home).catch(() => null);
  if (!realHome) return no(path, "outside-home");
  // Outside the home folder as written: refused without touching the disk.
  const lexical = P.resolve(expanded);
  if (!isUnder(platform, P.resolve(home), lexical) && !isUnder(platform, realHome, lexical)) return no(path, "outside-home");
  const real = await realpath(lexical).catch(() => null);
  if (!real) return no(path, "missing");
  // A link inside the home folder that leads out of it is outside it.
  if (!isUnder(platform, realHome, real)) return no(path, "outside-home");
  const st: Stats | null = await stat(real).catch(() => null);
  if (!st) return no(path, "missing");
  if (!st.isDirectory() && !st.isFile()) return no(path, "not-a-file");
  const target = await openTarget(real, platform);
  if (!target) return no(path, "missing");
  return { path, abs: target.real, ok: true, kind: target.kind, reveal: target.reveal };
}
