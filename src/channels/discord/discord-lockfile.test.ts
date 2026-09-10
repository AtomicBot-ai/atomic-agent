import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiscordLockfile } from "./discord-lockfile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "discord-lock-"));
  path = join(dir, "discord.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DiscordLockfile", () => {
  it("acquires and releases", () => {
    const lock = new DiscordLockfile(path);
    lock.acquire();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
    expect(new DiscordLockfile(path).held()).toBe(false);
  });

  it("refuses when a live process holds it", () => {
    // Two gateways on one token double every reply and run every turn
    // twice, side effects included -- Discord will not stop that for us.
    writeFileSync(path, String(process.pid + 0), "utf8");
    const other = new DiscordLockfile(path);
    // Same pid counts as ours, so simulate a foreign live holder:
    writeFileSync(path, String(process.ppid), "utf8");
    expect(() => other.acquire()).toThrow(/already running/);
  });

  it("reclaims a stale lock whose process is gone", () => {
    writeFileSync(path, "999999", "utf8");
    const lock = new DiscordLockfile(path);
    expect(() => lock.acquire()).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("reclaims a corrupt lock file", () => {
    writeFileSync(path, "not-a-pid", "utf8");
    expect(() => new DiscordLockfile(path).acquire()).not.toThrow();
  });

  it("does not delete a lock owned by someone else on release", () => {
    writeFileSync(path, String(process.ppid), "utf8");
    new DiscordLockfile(path).release();
    expect(readFileSync(path, "utf8")).toBe(String(process.ppid));
  });
});
