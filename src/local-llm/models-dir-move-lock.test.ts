import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireModelsDirMoveLock,
  assertNoModelsDirMove,
  MODELS_DIR_MOVE_REFRESH_MS,
  MODELS_DIR_MOVE_STALE_MS,
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

  it("reads a marker written before the last boot as free though its pid is alive again", () => {
    // A live pid that is not a mover: the parent of this test process.
    writeFileSync(modelsDirMoveLockPath(dataDir), String(process.ppid));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    utimesSync(modelsDirMoveLockPath(dataDir), twoDaysAgo, twoDaysAgo);
    const probes = { bootTimeMs: () => Date.now() - 3600_000 };
    expect(modelsDirMoveOwner(dataDir, probes)).toBeNull();
    expect(() => assertNoModelsDirMove(dataDir, probes)).not.toThrow();
    const release = acquireModelsDirMoveLock(dataDir, probes);
    expect(modelsDirMoveOwner(dataDir)).toBe(process.pid);
    release();
  });

  it("reads a marker untouched past the ceiling as free, even with a live pid since boot", () => {
    writeFileSync(modelsDirMoveLockPath(dataDir), String(process.ppid));
    const old = new Date(Date.now() - MODELS_DIR_MOVE_STALE_MS - 60_000);
    utimesSync(modelsDirMoveLockPath(dataDir), old, old);
    const probes = { bootTimeMs: () => Date.now() - 7 * 24 * 3600_000 };
    expect(modelsDirMoveOwner(dataDir, probes)).toBeNull();
    expect(() => acquireModelsDirMoveLock(dataDir, probes)()).not.toThrow();
  });

  it("still counts a fresh marker with a live pid as a move", () => {
    writeFileSync(modelsDirMoveLockPath(dataDir), String(process.ppid));
    const probes = { bootTimeMs: () => Date.now() - 3600_000 };
    expect(modelsDirMoveOwner(dataDir, probes)).toBe(process.ppid);
  });

  it("names the marker file in every refusal", () => {
    const release = acquireModelsDirMoveLock(dataDir);
    try {
      expect(() => assertNoModelsDirMove(dataDir)).toThrow(modelsDirMoveLockPath(dataDir));
      expect(() => acquireModelsDirMoveLock(dataDir)).toThrow(modelsDirMoveLockPath(dataDir));
    } finally {
      release();
    }
  });

  it("touches the marker while held, so a long move never reads as stale", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const release = acquireModelsDirMoveLock(dataDir);
      const path = modelsDirMoveLockPath(dataDir);
      const old = new Date(Date.now() - MODELS_DIR_MOVE_STALE_MS - 60_000);
      utimesSync(path, old, old);
      vi.advanceTimersByTime(MODELS_DIR_MOVE_REFRESH_MS);
      expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(MODELS_DIR_MOVE_STALE_MS);
      expect(modelsDirMoveOwner(dataDir)).toBe(process.pid);
      release();
      expect(existsSync(path)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
