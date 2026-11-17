import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePidFilePath } from "../backend-paths.js";
import {
  CORE_OPERATION_STALE_MS,
  readCoreOperationLock as readCoreOperationLockForTest,
  readCoreOperationLockForTurn,
} from "../core/core-operation.js";
import { explainManagedEngineLiveness, readManagedEngineLiveness, readManagedModelProcess } from "./engine-liveness.js";

describe("readManagedEngineLiveness (ATO-772)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-liveness-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
  const writePid = (value: string): void => writeFileSync(resolvePidFilePath(dataDir), value, "utf-8");
  const writeOperationLock = (pid: number): void => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    writeFileSync(join(dataDir, "core", "operation.lock"), String(pid));
  };

  it("no pid file is no_pid: never started, or stopped", () => {
    expect(readManagedEngineLiveness(dataDir)).toBe("no_pid");
  });

  it("an empty or garbled pid record is no_pid, like readRunningPid", () => {
    writePid("");
    expect(readManagedEngineLiveness(dataDir)).toBe("no_pid");
    writePid("not-a-pid");
    expect(readManagedEngineLiveness(dataDir)).toBe("no_pid");
  });

  it("a live recorded pid is alive", () => {
    writePid(String(process.pid));
    expect(readManagedEngineLiveness(dataDir)).toBe("alive");
  });

  it("a recorded pid that is gone is dead, and the pid file is left in place", () => {
    writePid(String(deadPid()));
    expect(readManagedEngineLiveness(dataDir)).toBe("dead");
    // Read only: a second look still sees the record a status call would.
    expect(readManagedEngineLiveness(dataDir)).toBe("dead");
  });

  it("a process owned by another user counts as running", () => {
    writePid("4242");
    expect(readManagedEngineLiveness(dataDir, { pidLiveness: () => "foreign" })).toBe("alive");
  });

  it("an engine operation under way (start, load, install) is unknown even with no pid", () => {
    writeOperationLock(process.pid);
    expect(readManagedEngineLiveness(dataDir)).toBe("unknown");
    writePid(String(deadPid()));
    expect(readManagedEngineLiveness(dataDir)).toBe("unknown");
  });

  it("a stale operation lock whose owner is gone does not hide a dead engine", () => {
    writeOperationLock(deadPid());
    expect(readManagedEngineLiveness(dataDir)).toBe("no_pid");
  });

  it("a probe that throws is unknown, never dead", () => {
    expect(readManagedEngineLiveness(dataDir, { operationLock: () => { throw new Error("EACCES"); } })).toBe("unknown");
    expect(explainManagedEngineLiveness(dataDir, { operationLock: () => { throw new Error("EACCES"); } })).toEqual({
      state: "unknown",
      reason: "lock_probe_failed",
      lock: "probe_failed",
    });
  });
});

describe("explainManagedEngineLiveness (ATO-1275)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-liveness-why-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const HOUR = 3_600_000;
  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
  const lockPath = (): string => join(dataDir, "core", "operation.lock");
  const writeLock = (pid: number | string): void => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    writeFileSync(lockPath(), String(pid));
  };
  const age = (path: string, ms: number): void => {
    const then = new Date(Date.now() - ms);
    utimesSync(path, then, then);
  };
  /** A live process that is not this one: the lock's owner in another frontend. */
  const otherLive = { pidLiveness: () => "alive" as const };

  it("names the branch for each pid reading", () => {
    expect(explainManagedEngineLiveness(dataDir)).toEqual({ state: "no_pid", reason: "no_pid_file", lock: "free" });
    writeFileSync(resolvePidFilePath(dataDir), "");
    expect(explainManagedEngineLiveness(dataDir)).toMatchObject({ state: "no_pid", reason: "pid_empty" });
    writeFileSync(resolvePidFilePath(dataDir), String(deadPid()));
    expect(explainManagedEngineLiveness(dataDir)).toMatchObject({ state: "dead", reason: "pid_dead" });
    writeFileSync(resolvePidFilePath(dataDir), String(process.pid));
    expect(explainManagedEngineLiveness(dataDir)).toMatchObject({ state: "alive", reason: "pid_alive" });
    expect(explainManagedEngineLiveness(dataDir, { pidLiveness: () => "foreign" })).toMatchObject({ state: "alive", reason: "pid_foreign" });
  });

  it("a lock held by another live process is a start or load under way: still unknown", () => {
    // The test runner's parent: alive, and not this process.
    writeLock(process.ppid);
    expect(explainManagedEngineLiveness(dataDir)).toEqual({ state: "unknown", reason: "lock_held", lock: "held" });
    expect(readManagedEngineLiveness(dataDir)).toBe("unknown");
  });

  it("a lock this process holds is still unknown, and says so", () => {
    writeLock(process.pid);
    expect(explainManagedEngineLiveness(dataDir)).toEqual({ state: "unknown", reason: "lock_held_self", lock: "held_self" });
  });

  it("a lock whose owner is dead, with no engine pid, reads no_pid: the turn can end", () => {
    writeLock(deadPid());
    expect(explainManagedEngineLiveness(dataDir)).toEqual({ state: "no_pid", reason: "no_pid_file", lock: "stale_dead_owner" });
  });

  it("a lock written before the last boot is stale even when its pid now names a live process", () => {
    writeLock(4242);
    age(lockPath(), 2 * HOUR);
    const bootTimeMs = () => Date.now() - HOUR;
    expect(explainManagedEngineLiveness(dataDir, {
      operationLock: (dir) => readCoreOperationLockForTest(dir, { bootTimeMs, ...otherLive }),
    })).toEqual({ state: "no_pid", reason: "no_pid_file", lock: "stale_before_boot" });
  });

  it("a pid file written before the last boot is dead even when the pid is reused", () => {
    writeFileSync(resolvePidFilePath(dataDir), String(process.pid));
    age(resolvePidFilePath(dataDir), 2 * HOUR);
    expect(explainManagedEngineLiveness(dataDir, { bootTimeMs: () => Date.now() - HOUR })).toMatchObject({
      state: "dead",
      reason: "pid_before_boot",
    });
    // Written after boot: the pid's own answer decides.
    expect(explainManagedEngineLiveness(dataDir, { bootTimeMs: () => Date.now() - 3 * HOUR })).toMatchObject({
      state: "alive",
      reason: "pid_alive",
    });
  });

  it("a lock held longer than any honest operation does not hide a dead engine (ATO-1433)", () => {
    // A pid that a crashed owner left on Windows, now naming another program.
    writeLock(process.ppid);
    age(lockPath(), CORE_OPERATION_STALE_MS + 60_000);
    // Boot long ago for both the lock and the pid file, so the reboot rule
    // never decides this on a machine that has only just started.
    const bootTimeMs = () => Date.now() - 30 * 24 * HOUR;
    const probes = {
      bootTimeMs,
      operationLock: (dir: string) => readCoreOperationLockForTurn(dir, { bootTimeMs }),
    };
    expect(explainManagedEngineLiveness(dataDir, probes)).toEqual({
      state: "no_pid",
      reason: "no_pid_file",
      lock: "stale_too_old",
    });
    writeFileSync(resolvePidFilePath(dataDir), String(deadPid()));
    expect(explainManagedEngineLiveness(dataDir, probes)).toMatchObject({
      state: "dead",
      reason: "pid_dead",
      lock: "stale_too_old",
    });
  });

  it("a fresh lock held by another live process still keeps the wait", () => {
    writeLock(process.ppid);
    expect(explainManagedEngineLiveness(dataDir)).toMatchObject({ state: "unknown", reason: "lock_held" });
  });

  it("an unreadable lock is not a start under way: the pid decides (ATO-1433)", () => {
    expect(explainManagedEngineLiveness(dataDir, { operationLock: () => "unreadable" })).toEqual({
      state: "no_pid",
      reason: "no_pid_file",
      lock: "unreadable",
    });
  });
});

describe("readManagedModelProcess (ATO-1434)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-process-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const longUp = { bootTimeMs: () => Date.now() - 30 * 24 * 3_600_000 };
  const writePid = (value: string): void => writeFileSync(resolvePidFilePath(dataDir), value, "utf-8");

  it("reads the pid file even while the engine lock is held", () => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    writeFileSync(join(dataDir, "core", "operation.lock"), String(process.ppid));
    expect(readManagedModelProcess(dataDir, longUp)).toBe("none");
    writePid(String(process.pid));
    expect(readManagedModelProcess(dataDir, longUp)).toBe("running");
  });

  it("no pid file, an empty one or a gone pid is none", () => {
    expect(readManagedModelProcess(dataDir, longUp)).toBe("none");
    writePid("");
    expect(readManagedModelProcess(dataDir, longUp)).toBe("none");
    writePid(String(spawnSync(process.execPath, ["-e", ""]).pid!));
    expect(readManagedModelProcess(dataDir, longUp)).toBe("none");
  });

  it("another user's process counts as running", () => {
    writePid("4242");
    expect(readManagedModelProcess(dataDir, { ...longUp, pidLiveness: () => "foreign" })).toBe("running");
  });
});
