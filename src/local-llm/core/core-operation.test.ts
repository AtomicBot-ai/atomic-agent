import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORE_OPERATION_STALE_MS,
  coreOperationInProgress,
  coreOperationLooksActive,
  readCoreOperationLock,
  readCoreOperationLockForTurn,
  writtenBeforeBoot,
} from "./core-operation.js";

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

/**
 * ATO-1433: a lock that reads held for longer than any honest operation
 * (a pid reused on Windows, an owner stuck forever) must not keep every
 * turn waiting. Read only: the file is never touched.
 */
describe("readCoreOperationLockForTurn / coreOperationLooksActive", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "core-op-turn-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const lockPath = (): string => join(dataDir, "core", "operation.lock");
  const writeLock = (content: string, ageMs = 0): void => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    writeFileSync(lockPath(), content);
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      utimesSync(lockPath(), then, then);
    }
  };
  /** Boot long ago, so the reboot rule never decides these. */
  const longUp = { bootTimeMs: () => Date.now() - 30 * 24 * 3_600_000 };

  it("a fresh lock held by another live process is an operation under way", () => {
    writeLock(String(process.ppid));
    expect(readCoreOperationLockForTurn(dataDir, longUp)).toBe("held");
    expect(coreOperationLooksActive(dataDir)).toBe(true);
  });

  it("the same lock older than the ceiling is not", () => {
    writeLock(String(process.ppid), CORE_OPERATION_STALE_MS + 60_000);
    expect(readCoreOperationLockForTurn(dataDir, longUp)).toBe("stale_too_old");
    expect(coreOperationLooksActive(dataDir)).toBe(false);
    // The plain reading, which nothing else changed, still says held.
    expect(readCoreOperationLock(dataDir, longUp)).toBe("held");
  });

  it("a lock this process holds goes stale the same way", () => {
    writeLock(String(process.pid));
    expect(readCoreOperationLockForTurn(dataDir, longUp)).toBe("held_self");
    writeLock(String(process.pid), CORE_OPERATION_STALE_MS + 60_000);
    expect(readCoreOperationLockForTurn(dataDir, longUp)).toBe("stale_too_old");
  });

  it("the ceiling is measured from the given clock", () => {
    writeLock(String(process.ppid));
    const mtime = statSync(lockPath()).mtimeMs;
    expect(coreOperationLooksActive(dataDir, mtime + CORE_OPERATION_STALE_MS - 1_000)).toBe(true);
    expect(coreOperationLooksActive(dataDir, mtime + CORE_OPERATION_STALE_MS + 1_000)).toBe(false);
  });

  it("the bare-pid format is read as before: a dead owner is stale", () => {
    writeLock(String(spawnSync(process.execPath, ["-e", ""]).pid!));
    expect(readCoreOperationLockForTurn(dataDir, longUp)).toBe("stale_dead_owner");
    expect(coreOperationLooksActive(dataDir)).toBe(false);
  });

  it("garbage in the file is not an operation under way once past the write window", () => {
    writeLock("not a pid", 60_000);
    expect(readCoreOperationLockForTurn(dataDir, longUp)).toBe("stale_no_owner");
    expect(coreOperationLooksActive(dataDir)).toBe(false);
  });

  it("no lock is free", () => {
    expect(readCoreOperationLockForTurn(dataDir)).toBe("free");
    expect(coreOperationLooksActive(dataDir)).toBe(false);
  });

  it("never changes or removes the lock file", () => {
    writeLock(String(process.ppid), CORE_OPERATION_STALE_MS + 60_000);
    const before = statSync(lockPath()).mtimeMs;
    coreOperationLooksActive(dataDir);
    readCoreOperationLockForTurn(dataDir);
    expect(readFileSync(lockPath(), "utf8")).toBe(String(process.ppid));
    expect(statSync(lockPath()).mtimeMs).toBe(before);
  });
});
