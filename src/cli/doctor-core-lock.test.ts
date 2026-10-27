import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCoreLocks } from "./doctor-core-lock.js";
import type { DoctorContext } from "./doctor-checks.js";

let state: string;
const lockDir = () => join(state, "models", "core", "versions", "0.18.6", "data", "atomic-core");
const ctx = (alive: boolean): DoctorContext => ({
  stateDir: state, configPath: join(state, "config.json"), platform: process.platform,
  findOnPath: () => true, chmod: () => {}, pidAlive: () => alive, now: () => new Date("2026-10-27T10:00:00Z"),
});
const writeLock = (dataFolder: string, pid = 4242) => {
  mkdirSync(lockDir(), { recursive: true });
  writeFileSync(join(lockDir(), "instance.lock"), JSON.stringify({ state: "ready", pid, data_folder: dataFolder }));
};

beforeEach(() => { state = mkdtempSync(join(tmpdir(), "core-lock-")); });
afterEach(() => { rmSync(state, { recursive: true, force: true }); });

describe("doctor: leftover Atomic Core lock (ATO-1233)", () => {
  it("a lock copied from another folder is named, and the fix moves it aside", () => {
    writeLock("/Users/someone/other/models/core/versions/0.18.6/data");
    const [f] = checkCoreLocks(ctx(true));
    expect(f).toMatchObject({ check: "core", status: "warn", message: expect.stringContaining("names another folder") });
    f!.fix!.file!();
    expect(existsSync(join(lockDir(), "instance.lock"))).toBe(false);
    expect(readdirSync(lockDir()).some((n) => n.startsWith("instance.lock.stale-"))).toBe(true);
  });

  it("a lock whose process is gone is named", () => {
    writeLock(join(state, "models", "core", "versions", "0.18.6", "data"));
    expect(checkCoreLocks(ctx(false))[0]).toMatchObject({ status: "warn", message: expect.stringContaining("is gone") });
  });

  it("the running Core's own lock is left alone", () => {
    writeLock(join(state, "models", "core", "versions", "0.18.6", "data"));
    const [f] = checkCoreLocks(ctx(true));
    expect(f).toMatchObject({ status: "ok" });
    expect(f!.fix).toBeUndefined();
  });

  it("no Core installed, nothing to say", () => {
    expect(checkCoreLocks(ctx(true))).toEqual([]);
  });
});
