import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/**
 * Single-instance enforcement primitive used by the Telegram channel.
 * Two parallel `getUpdates` requests against the same bot token receive
 * a 409 Conflict from Telegram's servers, so we serialise on the
 * operator's machine before the network ever sees a duplicate request.
 *
 * `acquire()` throws when another live process holds the file. Stale
 * locks (PID dead) are reclaimed transparently. `release()` is
 * best-effort — a lingering file just means the next `acquire()`
 * replaces it on the stale-lock path.
 */
export interface ChannelLock {
  acquire(): void;
  release(): void;
}

export class TelegramLockfile implements ChannelLock {
  constructor(private readonly path: string) {}

  acquire(): void {
    try {
      writeFileSync(this.path, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let pidStr = "";
    try {
      pidStr = readFileSync(this.path, "utf8").trim();
    } catch {
      pidStr = "";
    }
    const pid = Number.parseInt(pidStr, 10);
    if (
      Number.isFinite(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      isAlive(pid)
    ) {
      throw new Error(
        `telegram lockfile held by live pid ${pid} at ${this.path}`,
      );
    }
    writeFileSync(this.path, String(process.pid), { flag: "w" });
  }

  release(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // best-effort — a lingering file just means the next start
      // replaces it via the stale-lock branch above
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // `EPERM` (POSIX) / `EACCES` (Windows) both mean the process exists but
    // is owned by someone else — i.e. still alive. Only `ESRCH` means dead.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}
