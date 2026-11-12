import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreOperationInProgress, readCoreOperationLock, writtenBeforeBoot } from "./core-operation.js";

/**
 * ATO-1275: a lock its owner left behind must not read as an engine
 * operation under way, or a dead managed engine keeps the whole outage
 * wait. A lock a live process holds still does.
 */
describe("readCoreOperationLock", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "core-op-lock-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const HOUR = 3_600_000;
  const lockPath = (): string => join(dataDir, "core", "operation.lock");
  const writeLock = (content: string, ageMs = 0): void => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    writeFileSync(lockPath(), content);
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      utimesSync(lockPath(), then, then);
    }
  };
  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

  it("no lock file is free", () => {
    expect(readCoreOperationLock(dataDir)).toBe("free");
    expect(coreOperationInProgress(dataDir)).toBe(false);
  });

  it("a lock held by another live process is held: an operation is under way", () => {
    writeLock(String(process.ppid));
    expect(readCoreOperationLock(dataDir)).toBe("held");
    expect(coreOperationInProgress(dataDir)).toBe(true);
  });

  it("a lock this process holds is held_self, still in progress", () => {
    writeLock(String(process.pid));
    expect(readCoreOperationLock(dataDir)).toBe("held_self");
    expect(coreOperationInProgress(dataDir)).toBe(true);
  });

  it("a lock whose owner is gone is stale", () => {
    writeLock(String(deadPid()));
    expect(readCoreOperationLock(dataDir)).toBe("stale_dead_owner");
    expect(coreOperationInProgress(dataDir)).toBe(false);
  });

  it("a lock written before the last boot is stale, whatever its pid names now", () => {
    writeLock("4242", 2 * HOUR);
    const probes = { bootTimeMs: () => Date.now() - HOUR, pidLiveness: () => "alive" as const };
    expect(readCoreOperationLock(dataDir, probes)).toBe("stale_before_boot");
  });

  it("a lock written after boot keeps its owner's answer", () => {
    writeLock("4242", HOUR);
    const probes = { bootTimeMs: () => Date.now() - 2 * HOUR, pidLiveness: () => "alive" as const };
    expect(readCoreOperationLock(dataDir, probes)).toBe("held");
  });

  it("a lock with no pid yet is an owner mid-write while young, abandoned once old", () => {
    writeLock("");
    expect(readCoreOperationLock(dataDir)).toBe("writing");
    expect(coreOperationInProgress(dataDir)).toBe(true);
    writeLock("", 60_000);
    expect(readCoreOperationLock(dataDir)).toBe("stale_no_owner");
    expect(coreOperationInProgress(dataDir)).toBe(false);
  });

  it("a boot time that cannot be read never makes a lock stale", () => {
    writeLock(String(process.ppid), 2 * HOUR);
    expect(readCoreOperationLock(dataDir, { bootTimeMs: () => { throw new Error("no uptime"); } })).toBe("held");
  });
});

describe("writtenBeforeBoot", () => {
  it("allows slack for a clock corrected just after boot", () => {
    const boot = 1_000_000_000;
    expect(writtenBeforeBoot(boot - 60_000, boot)).toBe(true);
    expect(writtenBeforeBoot(boot - 10_000, boot)).toBe(false);
    expect(writtenBeforeBoot(boot + 1, boot)).toBe(false);
    expect(writtenBeforeBoot(boot - 60_000, Number.NaN)).toBe(false);
  });
});
