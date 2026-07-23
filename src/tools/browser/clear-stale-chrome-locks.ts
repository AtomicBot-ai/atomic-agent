import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Chromium locks under a persistent `--user-data-dir` that survive an
 * abrupt parent exit (SIGINT before `PlaywrightBackend.shutdown()` finishes,
 * kill -9, OOM, gasket timeout). On the next launch Chromium sees a live
 * SingletonLock owned by a dead PID and refuses to start — browser tools
 * then fail until the profile is manually cleaned.
 *
 * Safe policy: only remove lock files when the owner PID is missing or not
 * a Chromium/Chrome process. Never touch locks held by a living browser.
 *
 * Related: https://github.com/AtomicBot-ai/atomic-agent/issues/22
 */

/** File basenames Chromium uses as single-instance / CDP rendezvous markers. */
export const CHROME_LOCK_BASENAMES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "DevToolsActivePort",
] as const;

export interface ClearStaleChromeLocksResult {
  removed: string[];
  kept: string[];
  reasons: string[];
}

/**
 * Read the PID Chromium wrote into `SingletonLock`.
 * Formats seen in the wild:
 *   - symlink target `127.0.0.1-12345` (host-pid)
 *   - plain text `12345` or `hostname-12345`
 * Returns null when the file is missing or unparseable.
 */
export function readChromeSingletonLockPid(userDataDir: string): number | null {
  const lockPath = path.join(userDataDir, "SingletonLock");
  try {
    let payload: string | null = null;
    try {
      payload = fs.readlinkSync(lockPath);
    } catch {
      if (!fs.existsSync(lockPath)) return null;
      payload = fs.readFileSync(lockPath, "utf8").trim();
    }
    if (!payload) return null;
    // strip optional host prefix: "hostname-12345" or "127.0.0.1-12345"
    const m = payload.trim().match(/(?:^|-)(\d+)\s*$/);
    if (!m || m[1] === undefined) return null;
    const pid = Number(m[1]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True when `pid` is alive (signal 0 succeeds). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort: does the live PID look like a Chromium-family browser?
 * Used only to avoid deleting locks while a real Chrome still holds them
 * under a recycled PID race (extremely rare). On failure we treat as
 * "unknown → keep locks" when the PID is alive.
 */
export function processLooksLikeChromium(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase();
      return /chrome|chromium|msedge|brave|electron/.test(comm);
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 1000,
      }).trim().toLowerCase();
      return /chrome|chromium|msedge|brave|google chrome|electron|helper/.test(out);
    }
    // Windows: keep conservative — if alive, do not clear.
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear Chromium single-instance lock files when safe.
 *
 * - No SingletonLock → remove companion lock names if present (orphans).
 * - SingletonLock with dead PID → remove all lock basenames.
 * - SingletonLock with live non-Chrome PID → remove (stale PID recycle cleaning).
 * - SingletonLock with live Chromium PID → keep everything.
 */
export function clearStaleChromeLocks(
  userDataDir: string,
  opts: { now?: () => number } = {},
): ClearStaleChromeLocksResult {
  void opts; // reserved for future mtime grace windows
  const removed: string[] = [];
  const kept: string[] = [];
  const reasons: string[] = [];

  if (!fs.existsSync(userDataDir)) {
    return { removed, kept, reasons: ["userDataDir missing"] };
  }

  const pid = readChromeSingletonLockPid(userDataDir);
  let shouldClear = false;

  if (pid === null) {
    // No owner PID — companion locks alone are always safe to drop.
    shouldClear = true;
    reasons.push("no parseable SingletonLock pid");
  } else if (!isProcessAlive(pid)) {
    shouldClear = true;
    reasons.push(`pid ${pid} not alive`);
  } else if (!processLooksLikeChromium(pid)) {
    shouldClear = true;
    reasons.push(`pid ${pid} alive but not chromium-family`);
  } else {
    shouldClear = false;
    reasons.push(`pid ${pid} looks like a live chromium holder`);
  }

  for (const base of CHROME_LOCK_BASENAMES) {
    const full = path.join(userDataDir, base);
    if (!fs.existsSync(full) && !isSymlink(full)) {
      continue;
    }
    if (!shouldClear) {
      kept.push(base);
      continue;
    }
    try {
      fs.rmSync(full, { force: true });
      removed.push(base);
    } catch (err) {
      reasons.push(
        `failed to remove ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
      kept.push(base);
    }
  }

  return { removed, kept, reasons };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
