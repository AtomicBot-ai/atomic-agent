import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasOtherLiveSessions,
  registerSession,
  SESSION_PARENT_PID_ENV,
  sessionParentPid,
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

  // ATO-416: the desktop shares the state dir and spawns `atag` with
  // ATOMIC_AGENT_SESSION_PARENT_PID; its own marker is "self" for them.
  describe("session parent pid", () => {
    function writeMarker(pid: number): string {
      const dir = join(dataDir, "sessions");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, String(pid));
      writeFileSync(file, String(pid));
      return file;
    }

    it("counts the parent's live marker as self, not as another session", () => {
      const file = writeMarker(process.ppid);
      const env = { [SESSION_PARENT_PID_ENV]: String(process.ppid) };
      expect(hasOtherLiveSessions(dataDir, env)).toBe(false);
      // Self is skipped, never reclaimed: the parent is alive.
      expect(existsSync(file)).toBe(true);
      // Without the env the same marker is another live session.
      expect(hasOtherLiveSessions(dataDir, {})).toBe(true);
    });

    it("still sees a live session that is neither us nor the parent", async () => {
      const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      try {
        await new Promise<void>((resolve, reject) => {
          other.once("spawn", () => resolve());
          other.once("error", reject);
        });
        writeMarker(process.ppid);
        writeMarker(other.pid!);
        const env = { [SESSION_PARENT_PID_ENV]: String(process.ppid) };
        expect(hasOtherLiveSessions(dataDir, env)).toBe(true);
      } finally {
        other.kill("SIGKILL");
      }
    });

    it("reclaims a dead parent's marker", () => {
      const file = writeMarker(99999999);
      const env = { [SESSION_PARENT_PID_ENV]: "99999999" };
      expect(hasOtherLiveSessions(dataDir, env)).toBe(false);
      expect(existsSync(file)).toBe(false);
    });

    it.each(["", " ", "0", "-12", "abc", "0123", "12.5", "1e3"])(
      "ignores a malformed parent pid %j",
      (raw) => {
        expect(sessionParentPid({ [SESSION_PARENT_PID_ENV]: raw })).toBeNull();
      },
    );

    it("a malformed parent pid never hides a live session", () => {
      writeMarker(process.ppid);
      const env = { [SESSION_PARENT_PID_ENV]: `0${process.ppid}` };
      expect(hasOtherLiveSessions(dataDir, env)).toBe(true);
    });

    it("parses a canonical parent pid and reads process.env by default", () => {
      expect(sessionParentPid({ [SESSION_PARENT_PID_ENV]: "4242" })).toBe(4242);
      expect(sessionParentPid({ [SESSION_PARENT_PID_ENV]: " 4242 " })).toBe(4242);
      expect(sessionParentPid({})).toBeNull();
      const prior = process.env[SESSION_PARENT_PID_ENV];
      process.env[SESSION_PARENT_PID_ENV] = String(process.ppid);
      try {
        writeMarker(process.ppid);
        expect(hasOtherLiveSessions(dataDir)).toBe(false);
      } finally {
        if (prior === undefined) delete process.env[SESSION_PARENT_PID_ENV];
        else process.env[SESSION_PARENT_PID_ENV] = prior;
      }
    });
  });
});
