/**
 * Single-instance guard for the Discord channel.
 *
 * Two processes identifying with the same bot token both receive every
 * event, so the operator would get every answer twice and each turn
 * would run twice — including its side effects. Discord will not stop
 * that for us (unlike Telegram's 409 on parallel `getUpdates`), so the
 * guard has to be local and has to hold.
 *
 * Same shape as `TelegramLockfile`: `acquire()` throws when another
 * live process holds the file; a stale lock whose PID is gone is
 * reclaimed transparently.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export class DiscordLockfile {
  constructor(private readonly path: string) {}

  acquire(): void {
    try {
      writeFileSync(this.path, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = this.readPid();
    if (holder !== null && holder !== process.pid && isAlive(holder)) {
      throw new Error(
        `another atomic-agent (pid ${holder}) is already running the Discord channel — stop it first`,
      );
    }
    // Stale (or ours): reclaim it.
    writeFileSync(this.path, String(process.pid), "utf8");
  }

  release(): void {
    try {
      if (this.readPid() === process.pid) unlinkSync(this.path);
    } catch {
      // Best-effort: a lingering file is reclaimed by the next acquire.
    }
  }

  private readPid(): number | null {
    try {
      const pid = Number(readFileSync(this.path, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** True when the lock file exists on disk. Diagnostic only. */
  held(): boolean {
    return existsSync(this.path);
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 probes without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user -- still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
