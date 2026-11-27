import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "./device-file-lock.js";

/** ATO-2308: serve and `atag pair` both change http-devices.json under this lock. */
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-lock-"));
  file = join(dir, "http-devices.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("holds <file>.lock while the function runs and removes it after, also on a throw", () => {
    expect(withFileLock(file, () => existsSync(`${file}.lock`))).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(() => withFileLock(file, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("waits for a live holder, then gives up with an error", () => {
    writeFileSync(`${file}.lock`, "");
    expect(() => withFileLock(file, () => 1, { waitMs: 50 })).toThrow(/busy/);
    // Never removed a live holder's lock.
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("takes over a lock a dead holder left behind", () => {
    writeFileSync(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(withFileLock(file, () => "ran", { waitMs: 200, staleMs: 10_000 })).toBe("ran");
  });
});
