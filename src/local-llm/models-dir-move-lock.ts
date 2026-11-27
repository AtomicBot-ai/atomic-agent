import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * it as free and the next mover reclaims it.
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, another user's process.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The live pid holding the marker, or null when no move is under way. */
export function modelsDirMoveOwner(dataDir: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(modelsDirMoveLockPath(dataDir), "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid < 1) return null;
  return pidAlive(pid) ? pid : null;
}

/** An empty marker a few seconds old: its owner is between the create and the pid write. */
function justCreated(path: string): boolean {
  try {
    return readFileSync(path, "utf8").trim() === "" && Date.now() - statSync(path).mtimeMs < 10_000;
  } catch {
    return false;
  }
}

/** The words every refused start or download uses while a move runs. */
export const MODELS_DIR_MOVE_BUSY_MESSAGE =
  "the models are being moved to another folder; wait for the move to finish, then try again";

/**
 * Refuse a model start or a download while a move of the models folder
 * runs, in another process or in this one (the TUI moves in-process).
 */
export function assertNoModelsDirMove(dataDir: string): void {
  if (modelsDirMoveOwner(dataDir) !== null) throw new ModelsDirMoveBusyError(MODELS_DIR_MOVE_BUSY_MESSAGE);
}

/**
 * Take the marker, or throw `ModelsDirMoveBusyError` while another live
 * process holds it. Answers the release, which removes the file only while
 * it still names this process.
 */
export function acquireModelsDirMoveLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = modelsDirMoveLockPath(dataDir);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (modelsDirMoveOwner(dataDir) !== null || justCreated(path)) {
      throw new ModelsDirMoveBusyError("the models are already being moved; wait for that move to finish");
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
  return () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {
      /* gone already */
    }
  };
}
