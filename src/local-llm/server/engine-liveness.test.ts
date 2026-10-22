import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePidFilePath } from "../backend-paths.js";
import { readManagedEngineLiveness } from "./engine-liveness.js";

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
    expect(readManagedEngineLiveness(dataDir, { operationInProgress: () => { throw new Error("EACCES"); } })).toBe("unknown");
  });
});
