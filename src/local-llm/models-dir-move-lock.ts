import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { machineBootTimeMs, writtenBeforeBoot } from "./core/core-operation.js";

/**
 * A move of the models folder is under way in some process (ATO-2503).
 *
 * `atomic-agent models dir <folder>` (the CLI, the TUI and the desktop card
 * all run it) holds this marker from before its "is a model running?"
 * check until the config points at the new folder, and every model start
 * and download checks it first (`assertNoModelsDirMove`). Before, a desktop
 * auto-restart or a TUI launch could start a model in the middle of a long
 * copy to another disk, reading a half-copied GGUF from the new folder or
 * holding the old one open while it was deleted. Same rule as LM Studio,
 * which blocks loading while it changes the models directory.
 *
 * The file holds the mover's pid and nothing else. A marker whose owner is
 * gone (a move killed with SIGKILL, a crash) is not a move: readers treat
 * it as free and the next mover reclaims it. A live pid alone is not proof
 * (Windows reuses pids fast, a reboot starts them over), so the same
 * staleness rules as chat-start.pending and the engine operation lock
 * apply: a marker written before the last boot, or one whose mtime is
 * older than `MODELS_DIR_MOVE_STALE_MS`, is free too. The mover touches
 * the marker every `MODELS_DIR_MOVE_REFRESH_MS` while it holds it, so a
 * long copy to a slow disk never reads as stale.
 */
export const MODELS_DIR_MOVE_LOCK_FILE = "models-move.lock";

export class ModelsDirMoveBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsDirMoveBusyError";
  }
}

export function modelsDirMoveLockPath(dataDir: string): string {
  return join(dataDir, MODELS_DIR_MOVE_LOCK_FILE);
}

/** A held marker is touched this often, so its mtime says the mover is still there. */
export const MODELS_DIR_MOVE_REFRESH_MS = 30_000;
/** A marker untouched for this long is left over from a mover that died. */
export const MODELS_DIR_MOVE_STALE_MS = 5 * 60_000;
/** How long a marker may stay empty: the owner writes its pid in the same tick as the create. */
const MARKER_WRITE_WINDOW_MS = 10_000;

/** Test seams for the staleness rules; production uses the real clock, boot time and signal 0. */
export interface ModelsDirMoveProbes {
  now?: () => number;
  bootTimeMs?: () => number;
  pidAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, another user's process.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Whether the marker's mtime says a mover may still hold it: not written before boot, not older than the ceiling. */
function markerFresh(path: string, probes: ModelsDirMoveProbes): { fresh: boolean; ageMs: number } {
  const now = (probes.now ?? Date.now)();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { fresh: false, ageMs: Number.POSITIVE_INFINITY };
  }
  let bootTimeMs: number;
  try {
    bootTimeMs = (probes.bootTimeMs ?? machineBootTimeMs)();
  } catch {
    bootTimeMs = Number.NaN;
  }
  const ageMs = now - mtimeMs;
  if (writtenBeforeBoot(mtimeMs, bootTimeMs)) return { fresh: false, ageMs };
  return { fresh: ageMs <= MODELS_DIR_MOVE_STALE_MS, ageMs };
}

/** The live pid holding the marker, or null when no move is under way. */
export function modelsDirMoveOwner(dataDir: string, probes: ModelsDirMoveProbes = {}): number | null {
  const path = modelsDirMoveLockPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (!markerFresh(path, probes).fresh) return null;
  return (probes.pidAlive ?? pidAlive)(pid) ? pid : null;
}

/** An empty marker a few seconds old: its owner is between the create and the pid write. */
function justCreated(path: string, probes: ModelsDirMoveProbes): boolean {
  try {
    if (readFileSync(path, "utf8").trim() !== "") return false;
  } catch {
    return false;
  }
  const { fresh, ageMs } = markerFresh(path, probes);
  return fresh && ageMs < MARKER_WRITE_WINDOW_MS;
}

/** The words every refused start or download uses while a move runs. */
export const MODELS_DIR_MOVE_BUSY_MESSAGE =
  "the models are being moved to another folder; wait for the move to finish, then try again";

/**
 * Refuse a model start or a download while a move of the models folder
 * runs, in another process or in this one (the TUI moves in-process).
 */
export function assertNoModelsDirMove(dataDir: string, probes: ModelsDirMoveProbes = {}): void {
  if (modelsDirMoveOwner(dataDir, probes) !== null) {
    throw new ModelsDirMoveBusyError(`${MODELS_DIR_MOVE_BUSY_MESSAGE}${staleHint(dataDir)}`);
  }
}

/**
 * Where the marker is, for the rare case it is wrong (a pid reused before
 * the staleness ceiling): the person can remove it by hand. Frontends put
 * this part behind "Details".
 */
function staleHint(dataDir: string): string {
  return ` (if no move is running, delete ${modelsDirMoveLockPath(dataDir)})`;
}

/**
 * Take the marker, or throw `ModelsDirMoveBusyError` while another live
 * process holds it. Answers the release, which removes the file only while
 * it still names this process.
 */
export function acquireModelsDirMoveLock(dataDir: string, probes: ModelsDirMoveProbes = {}): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = modelsDirMoveLockPath(dataDir);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (modelsDirMoveOwner(dataDir, probes) !== null || justCreated(path, probes)) {
      throw new ModelsDirMoveBusyError(`the models are already being moved; wait for that move to finish${staleHint(dataDir)}`);
    }
    // The owner is gone: reclaim. A second reclaimer racing here loses on `wx`.
    try {
      unlinkSync(path);
    } catch {
      /* already reclaimed */
    }
    fd = openSync(path, "wx", 0o600);
  }
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  const mine = (): boolean => {
    try {
      return readFileSync(path, "utf8").trim() === String(process.pid);
    } catch {
      return false;
    }
  };
  // Keep the mtime fresh while the move runs, so readers never take a long
  // copy for a dead mover. Unref: the timer never keeps a process alive.
  const refresh = setInterval(() => {
    if (!mine()) return;
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      /* gone: release or another reclaimer */
    }
  }, MODELS_DIR_MOVE_REFRESH_MS);
  refresh.unref?.();
  return () => {
    clearInterval(refresh);
    try {
      if (mine()) unlinkSync(path);
    } catch {
      /* gone already */
    }
  };
}
