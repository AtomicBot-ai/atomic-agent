import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TelegramLockfile } from "./telegram-lockfile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-tg-lock-"));
  path = join(dir, "telegram.lock");
});
afterEach(() => {
  // A 0o000 file from the unreadable-lock case still has to be
  // removable, and its directory is ours, so force is enough.
  rmSync(dir, { recursive: true, force: true });
});

describe("TelegramLockfile", () => {
  it("acquires and then releases its own lock", () => {
    const lock = new TelegramLockfile(path);
    lock.acquire();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("leaves a lock owned by another process alone", () => {
    // The regression this pins: the loser of an acquire() race releases
    // from `TelegramChannel.start()`'s catch block. Deleting the file
    // there erases the WINNER's lock, so a third process acquires
    // cleanly and two pollers end up on one token -- the 409 the
    // lockfile exists to prevent.
    writeFileSync(path, String(process.ppid), "utf8");
    new TelegramLockfile(path).release();
    expect(readFileSync(path, "utf8")).toBe(String(process.ppid));
  });

  it("does not delete a live holder's lock when acquire() was refused", () => {
    // End-to-end at the lockfile level: acquire() throws, the caller
    // releases in its failure path, the holder's file survives.
    writeFileSync(path, String(process.ppid), "utf8");
    const loser = new TelegramLockfile(path);
    expect(() => loser.acquire()).toThrow(/already running/);
    loser.release();
    expect(readFileSync(path, "utf8")).toBe(String(process.ppid));
  });

  it.each([
    { name: "missing file", write: null },
    { name: "empty file", write: "" },
    { name: "garbage contents", write: "not-a-pid" },
    { name: "a dead pid", write: "999999" },
    { name: "a negative pid", write: "-1" },
    { name: "a fractional pid", write: "12.34" },
  ])("release() does not throw on $name, and removes nothing", ({ write }) => {
    // Two assertions, because "did not throw" alone passes for a
    // release() that deletes every one of these. Anything we cannot
    // read as our own pid belongs to someone else until proven
    // otherwise; acquire()'s stale branch reclaims the junk safely,
    // so leaving it costs nothing and removing it can cost the token.
    if (write !== null) writeFileSync(path, write, "utf8");
    expect(() => new TelegramLockfile(path).release()).not.toThrow();
    expect(existsSync(path)).toBe(write !== null);
  });

  // chmod is advisory for root and meaningless on Windows, so the
  // unreadable case can only be staged where file modes bite.
  const modesBite =
    process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;

  it.runIf(modesBite)(
    "leaves an unreadable lock file alone instead of unlinking blind",
    () => {
      // The tempting shortcut is to treat a failed read as "nothing of
      // ours is there" and unlink anyway. On POSIX that deletes the
      // file regardless: unlink permission comes from the *directory*,
      // which is ours, so an unreadable lock held by another user's
      // atomic-agent would be swept away and its token handed to a
      // second poller.
      writeFileSync(path, String(process.ppid), "utf8");
      chmodSync(path, 0o000);
      try {
        expect(() => new TelegramLockfile(path).release()).not.toThrow();
        expect(existsSync(path)).toBe(true);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it.runIf(modesBite)("stays silent when the unlink itself fails", () => {
    // The other half of the contract: the read can succeed and the
    // unlink still fail -- a read-only state dir, or the holder's own
    // stop() landing between the two syscalls. release() is called
    // from failure paths that must not acquire a second failure.
    const lock = new TelegramLockfile(path);
    lock.acquire();
    chmodSync(dir, 0o500);
    try {
      expect(() => lock.release()).not.toThrow();
      expect(existsSync(path)).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("still reclaims a stale lock on acquire()", () => {
    // Guarding release() must not touch the reclaim path: a dead
    // holder's file is still taken over, or a crash would wedge the
    // channel until someone deleted the file by hand.
    writeFileSync(path, "999999", "utf8");
    const lock = new TelegramLockfile(path);
    expect(() => lock.acquire()).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
    expect(existsSync(path)).toBe(false);
  });
});
