import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePidFilePath } from "../backend-paths.js";
import { coreSessionPath } from "../core/core-state.js";
import { readChatDaemonPidState } from "./daemon-lifecycle.js";

/** A pid that existed a moment ago and is gone now. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pid-state-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readChatDaemonPidState", () => {
  it("is no_pid when neither a Core session record nor a pid file exists", () => {
    expect(readChatDaemonPidState(dataDir())).toBe("no_pid");
  });

  it("reads the pid file in llama-server mode", () => {
    const dir = dataDir();
    writeFileSync(resolvePidFilePath(dir), String(process.pid));
    expect(readChatDaemonPidState(dir)).toBe("alive");
    writeFileSync(resolvePidFilePath(dir), String(exitedPid()));
    expect(readChatDaemonPidState(dir)).toBe("dead");
  });

  it("prefers the Core session record's pid over the pid file", () => {
    const dir = dataDir();
    const record = coreSessionPath(dir, "chat");
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ pid: exitedPid(), port: 1 }));
    writeFileSync(resolvePidFilePath(dir), String(process.pid));
    expect(readChatDaemonPidState(dir)).toBe("dead");
  });

  it("never deletes a stale pid file, unlike readRunningPid", () => {
    const dir = dataDir();
    writeFileSync(resolvePidFilePath(dir), String(exitedPid()));
    expect(readChatDaemonPidState(dir)).toBe("dead");
    expect(existsSync(resolvePidFilePath(dir))).toBe(true);
  });

  it("treats a garbage pid file as no_pid", () => {
    const dir = dataDir();
    writeFileSync(resolvePidFilePath(dir), "not a pid");
    expect(readChatDaemonPidState(dir)).toBe("no_pid");
  });
});
