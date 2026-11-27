import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireModelsDirMoveLock,
  assertNoModelsDirMove,
  ModelsDirMoveBusyError,
  modelsDirMoveLockPath,
  modelsDirMoveOwner,
} from "./models-dir-move-lock.js";

/** A pid no process has: far above any real pid range. */
const DEAD_PID = 2 ** 22 + 12345;

describe("models folder move marker (ATO-2503)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-models-move-lock-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("is free with no marker", () => {
    expect(modelsDirMoveOwner(dataDir)).toBeNull();
    expect(() => assertNoModelsDirMove(dataDir)).not.toThrow();
  });

  it("refuses starts and a second mover while held, and frees on release", () => {
    const release = acquireModelsDirMoveLock(dataDir);
    expect(modelsDirMoveOwner(dataDir)).toBe(process.pid);
    expect(() => assertNoModelsDirMove(dataDir)).toThrow(ModelsDirMoveBusyError);
    expect(() => assertNoModelsDirMove(dataDir)).toThrow(/being moved to another folder/);
    expect(() => acquireModelsDirMoveLock(dataDir)).toThrow(/already being moved/);
    release();
    expect(existsSync(modelsDirMoveLockPath(dataDir))).toBe(false);
    expect(() => assertNoModelsDirMove(dataDir)).not.toThrow();
  });

  it("reads a marker whose owner died as free and reclaims it", () => {
    writeFileSync(modelsDirMoveLockPath(dataDir), String(DEAD_PID));
    expect(modelsDirMoveOwner(dataDir)).toBeNull();
    expect(() => assertNoModelsDirMove(dataDir)).not.toThrow();
    const release = acquireModelsDirMoveLock(dataDir);
    expect(modelsDirMoveOwner(dataDir)).toBe(process.pid);
    release();
  });

  it("treats a fresh empty marker as an owner about to write its pid", () => {
    writeFileSync(modelsDirMoveLockPath(dataDir), "");
    expect(() => acquireModelsDirMoveLock(dataDir)).toThrow(/already being moved/);
  });

  it("release leaves a marker another process took over", () => {
    const release = acquireModelsDirMoveLock(dataDir);
    writeFileSync(modelsDirMoveLockPath(dataDir), String(DEAD_PID + 1));
    release();
    expect(existsSync(modelsDirMoveLockPath(dataDir))).toBe(true);
  });
});
