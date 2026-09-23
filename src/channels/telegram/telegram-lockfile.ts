import { formatChannelLockHeld } from "../channel-lock-error.js";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Single-instance enforcement primitive used by the Telegram channel.
 * Two parallel `getUpdates` requests against the same bot token receive
 * a 409 Conflict from Telegram's servers, so we serialise on the
 * operator's machine before the network ever sees a duplicate request.
 *
 * `acquire()` throws when another live process holds the file. Stale
 * locks (PID dead) are reclaimed transparently. `release()` is
 * best-effort and removes the file only when this process owns it —
 * removing someone else's lock hands the token to a second poller, and
 * a file we leave behind is reclaimed by the next `acquire()` as long
 * as its PID is dead.
 *
 * The residual case, shared with `DiscordLockfile`: a holder killed
 * without releasing leaves a PID the OS may later recycle onto an
 * unrelated process. `acquire()` then sees a live PID and keeps
 * refusing, so the channel stays down until the file is deleted by
 * hand. That is the deliberate trade — a rare manual unwedge beats
 * silently allowing two pollers on one token.
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
      // Names the cause and the fix: this surfaces verbatim in the
      // Integrations pane, where "lockfile held by live pid 123" reads
      // as a crash rather than as "you already have one running".
      throw new Error(formatChannelLockHeld(pid));
    }
    writeFileSync(this.path, String(process.pid), { flag: "w" });
  }

  release(): void {
    try {
      // Only the owner may remove the file. Deleting it on sight is
      // worse than leaving it: the process that LOSES the acquire()
      // race releases from `TelegramChannel.start()`'s catch block, so
      // an unguarded release erases the WINNER's lock. The winner keeps
      // polling — its state is in memory — while the file is gone, so
      // the next process acquires "successfully" and two pollers share
      // one token. That is the 409 this class exists to prevent.
      const holder = Number.parseInt(
        readFileSync(this.path, "utf8").trim(),
        10,
      );
      if (holder === process.pid) unlinkSync(this.path);
    } catch {
      // best-effort — a missing or unreadable file leaves nothing of
      // ours to remove, and a lingering one is replaced by the next
      // start via the stale-lock branch above
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
