import {
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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
  ])("release() does not throw on $name", ({ write }) => {
    if (write !== null) writeFileSync(path, write, "utf8");
    expect(() => new TelegramLockfile(path).release()).not.toThrow();
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
