import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasOtherLiveSessions,
  registerSession,
} from "./session-registry.js";

describe("session-registry", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "aa-sessions-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("registerSession writes a marker for this pid and release removes it", () => {
    const release = registerSession(dataDir);
    expect(readdirSync(join(dataDir, "sessions"))).toEqual([
      String(process.pid),
    ]);
    release();
    expect(readdirSync(join(dataDir, "sessions"))).toEqual([]);
    // Releasing twice is safe.
    release();
  });

  it("reports no other sessions when only this process is registered", () => {
    const release = registerSession(dataDir);
    expect(hasOtherLiveSessions(dataDir)).toBe(false);
    release();
  });

  it("reports no other sessions when the directory does not exist", () => {
    expect(hasOtherLiveSessions(dataDir)).toBe(false);
  });

  it("sees another live process (the test runner's parent)", () => {
    const dir = join(dataDir, "sessions");
    mkdirSync(dir, { recursive: true });
    // `process.ppid` is a live pid that is not us.
    writeFileSync(join(dir, String(process.ppid)), String(process.ppid));
    expect(hasOtherLiveSessions(dataDir)).toBe(true);
  });

  it("reclaims stale markers from dead pids and garbage names", () => {
    const dir = join(dataDir, "sessions");
    mkdirSync(dir, { recursive: true });
    // Max pid on Linux defaults to ~4M; anything above is guaranteed dead
    // on every platform we ship.
    writeFileSync(join(dir, "99999999"), "99999999");
    writeFileSync(join(dir, "not-a-pid"), "junk");
    expect(hasOtherLiveSessions(dataDir)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
