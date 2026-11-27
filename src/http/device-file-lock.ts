import { closeSync, openSync, rmSync, statSync } from "node:fs";

/**
 * ATO-2308: a tiny cross-process lock for `http-devices.json`. Two
 * processes write that file: `atag serve` (a phone redeems its pairing
 * link, a device is seen) and `atag pair` (a new link, a revoke). Without
 * a lock, a read-modify-write in one could overwrite the other's change,
 * and a lost revoke would leave a phone signed in.
 *
 * The lock is a `<file>.lock` created exclusively (`wx`). A holder that
 * died leaves it behind; one older than `staleMs` is taken over. Waiting
 * is a short synchronous sleep: every critical section is a read and a
 * rename of a small file, done in well under a millisecond.
 */

const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_STALE_MS = 10_000;
const RETRY_SLEEP_MS = 10;

export interface FileLockOptions {
  /** How long to wait for the lock before giving up. */
  waitMs?: number;
  /** A lock file older than this is a dead holder's, and is removed. */
  staleMs?: number;
  now?: () => number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryRemoveStale(lockPath: string, staleMs: number, now: number): void {
  try {
    if (now - statSync(lockPath).mtimeMs > staleMs) rmSync(lockPath, { force: true });
  } catch {
    // Gone already: the next try takes it.
  }
}

/** Run `fn` while holding `<path>.lock`; throws when the lock stays busy past `waitMs`. */
export function withFileLock<T>(path: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = `${path}.lock`;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      tryRemoveStale(lockPath, staleMs, now());
      if (now() >= deadline) throw new Error(`${lockPath} is busy; try again`);
      sleepSync(RETRY_SLEEP_MS);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}
