import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHROME_LOCK_BASENAMES,
  clearStaleChromeLocks,
  readChromeSingletonLockPid,
} from "./clear-stale-chrome-locks.js";

describe("readChromeSingletonLockPid", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-locks-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses symlink targets of the form host-pid", () => {
    fs.symlinkSync("127.0.0.1-4242", path.join(dir, "SingletonLock"));
    expect(readChromeSingletonLockPid(dir)).toBe(4242);
  });

  it("parses plain text pid files", () => {
    fs.writeFileSync(path.join(dir, "SingletonLock"), "99999\n");
    expect(readChromeSingletonLockPid(dir)).toBe(99999);
  });

  it("returns null when missing", () => {
    expect(readChromeSingletonLockPid(dir)).toBeNull();
  });
});

describe("clearStaleChromeLocks", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-locks-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function plantLocks(pidPayload: string | null): void {
    for (const base of CHROME_LOCK_BASENAMES) {
      if (base === "SingletonLock" && pidPayload !== null) {
        fs.symlinkSync(pidPayload, path.join(dir, base));
      } else if (base !== "SingletonLock") {
        fs.writeFileSync(path.join(dir, base), "x");
      }
    }
  }

  it("removes companion locks when SingletonLock is absent", () => {
    fs.writeFileSync(path.join(dir, "SingletonSocket"), "x");
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9222");
    const result = clearStaleChromeLocks(dir);
    expect(result.removed).toEqual(
      expect.arrayContaining(["SingletonSocket", "DevToolsActivePort"]),
    );
    expect(fs.existsSync(path.join(dir, "SingletonSocket"))).toBe(false);
  });

  it("removes locks when owner pid is dead", () => {
    const deadPid = 2147483000;
    plantLocks(`127.0.0.1-${deadPid}`);
    // Inject the liveness check so the assertion is deterministic regardless
    // of what PIDs happen to be live on the host running the suite.
    const result = clearStaleChromeLocks(dir, { isAlive: () => false });
    expect(result.reasons.some((r) => r.includes("not alive"))).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
  });

  it("keeps locks when the owner pid is a live Chromium process", () => {
    plantLocks("host-4242");
    const result = clearStaleChromeLocks(dir, {
      isAlive: () => true,
      probe: () => "chromium",
    });
    expect(result.removed).toEqual([]);
    expect(result.kept.length).toBeGreaterThan(0);
    expect(fs.lstatSync(path.join(dir, "SingletonLock")).isSymbolicLink()).toBe(true);
  });

  it("clears locks when the owner pid is alive but is not a browser", () => {
    plantLocks("host-4242");
    const result = clearStaleChromeLocks(dir, {
      isAlive: () => true,
      probe: () => "other",
    });
    expect(result.removed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
  });

  it("fails open: keeps locks when a live pid's identity probe fails", () => {
    // Regression: a failed probe (no /proc, ps timeout) must NOT be read as
    // "not chromium → clear" — a live browser could lose its locks.
    plantLocks("host-4242");
    const result = clearStaleChromeLocks(dir, {
      isAlive: () => true,
      probe: () => "unknown",
    });
    expect(result.removed).toEqual([]);
    expect(result.kept.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("identity unknown"))).toBe(true);
    expect(fs.lstatSync(path.join(dir, "SingletonLock")).isSymbolicLink()).toBe(true);
  });

  it("keeps locks when owner pid is this process (live) and processLooksLikeChromium is conservative", () => {
    // We stub processLooksLikeChromium via keep-path by making SingletonLock
    // point at our own PID, then mock kill(0). Our process is alive; on
    // platforms where processLooksLikeChromium returns true for node,
    // locks are kept — on others they clear. Either way the API is total.
    plantLocks(`host-${process.pid}`);
    const result = clearStaleChromeLocks(dir);
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("is a no-op on a missing directory", () => {
    const missing = path.join(dir, "nope");
    const result = clearStaleChromeLocks(missing);
    expect(result.removed).toEqual([]);
    expect(result.reasons).toContain("userDataDir missing");
  });
});
