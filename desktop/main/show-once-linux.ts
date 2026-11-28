import { execFile, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

import { parseShowOnceProbe, type ShowOnceProbe } from "./show-once-probe.js";

/**
 * ATO-2499 "Show once" on Linux (X11): which app and window an event
 * happened in, asked of `xdotool` once per event:
 *
 *   xdotool getactivewindow getwindowgeometry --shell getwindowname getwindowpid
 *
 * The app is the process behind the window's _NET_WM_PID; its bundleId is
 * the executable's name (/proc/<pid>/exe, else /proc/<pid>/comm), which
 * show-once-classify.ts matches against its Linux lists. A click asks for
 * the window in front too: by the time the question runs the click has
 * raised its window. No control names: AT-SPI is not read, so steps say
 * where in the window, not which button. Wayland gives no such answers,
 * which show-once-platform.ts says before Record. No electron import.
 */

export const SHOW_ONCE_XDOTOOL_ARGS: readonly string[] = ["getactivewindow", "getwindowgeometry", "--shell", "getwindowname", "getwindowpid"];

export interface XdotoolWindow {
  title: string | null;
  pid: number | null;
  rect: { x: number; y: number; width: number; height: number } | null;
}

/** xdotool's output: the KEY=value geometry lines, then the title, then the pid. */
export function parseXdotool(stdout: string): XdotoolWindow {
  const geo: Record<string, number> = {};
  const rest: string[] = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = /^(WINDOW|X|Y|WIDTH|HEIGHT|SCREEN)=(-?\d+)$/.exec(line.trim());
    if (m) geo[m[1]!] = Number(m[2]);
    else if (line.length) rest.push(line);
  }
  const pidLine = rest.length >= 2 ? rest[rest.length - 1]!.trim() : "";
  const pid = /^\d{1,9}$/.test(pidLine) ? Number(pidLine) : null;
  const title = (pid !== null ? rest.slice(0, -1) : rest).join(" ").trim().slice(0, 200) || null;
  const rect = geo.WIDTH! > 0 && geo.HEIGHT! > 0 && Number.isFinite(geo.X) && Number.isFinite(geo.Y)
    ? { x: geo.X!, y: geo.Y!, width: geo.WIDTH!, height: geo.HEIGHT! } : null;
  return { title, pid, rect };
}

export interface LinuxProcReader {
  readlink(path: string): string;
  readFile(path: string): string;
}

const realProc: LinuxProcReader = {
  readlink: (p) => readlinkSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
};

/** The executable's name for a pid, lowercased; null when /proc does not say. */
export function linuxExeName(pid: number, proc: LinuxProcReader = realProc): string | null {
  try {
    const exe = basename(proc.readlink(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")).toLowerCase();
    if (exe) return exe.slice(0, 120);
  } catch { /* another user's process, or gone */ }
  try {
    const comm = proc.readFile(`/proc/${pid}/comm`).trim().toLowerCase();
    return comm ? comm.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** A Linux answer in the probe's shape (show-once-probe.ts). */
export function linuxProbe(w: XdotoolWindow, proc: LinuxProcReader = realProc): ShowOnceProbe {
  const exe = w.pid !== null ? linuxExeName(w.pid, proc) : null;
  return parseShowOnceProbe({
    app: exe ? { name: exe, bundleId: exe, pid: w.pid } : null,
    window: w.rect,
    windowTitle: w.title,
  });
}

/** Runs xdotool; a failure or a slow answer (2 s) is an empty probe, never a throw. */
export function runShowOnceLinuxProbe(): Promise<ShowOnceProbe> {
  return new Promise((resolve) => {
    try {
      execFile("xdotool", [...SHOW_ONCE_XDOTOOL_ARGS], { timeout: 2000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        resolve(err && !stdout ? parseShowOnceProbe({}) : linuxProbe(parseXdotool(String(stdout))));
      });
    } catch {
      resolve(parseShowOnceProbe({}));
    }
  });
}

/** Whether `xdotool` runs on this computer. */
export function hasXdotool(): boolean {
  try {
    return spawnSync("xdotool", ["version"], { timeout: 2000, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
