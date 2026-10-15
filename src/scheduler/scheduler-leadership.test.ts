import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSchedulerLeadership,
  SCHEDULER_LOCK_FILE,
  TELEGRAM_LOCK_FILE,
} from "./scheduler-leadership.js";

// ATO-416: the desktop's `atag serve` and the TUI share one state dir.
// Two "processes" are modelled in one test with injected pids and a
// liveness table, against real lock files in a temp dir.
describe("scheduler leadership", () => {
  let stateDir: string;
  let live: Set<number>;
  const A = 1001;
  const B = 1002;

  const leadership = (pid: number, telegramWanted = false) =>
    createSchedulerLeadership({
      stateDir,
      pid,
      isAlive: (p) => live.has(p),
      telegramWanted: () => telegramWanted,
    });
  const schedulerHolder = () => {
    const path = join(stateDir, SCHEDULER_LOCK_FILE);
    return existsSync(path) ? Number(readFileSync(path, "utf8")) : null;
  };
  const holdTelegram = (pid: number) =>
    writeFileSync(join(stateDir, TELEGRAM_LOCK_FILE), String(pid));

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "aa-sched-lead-"));
    live = new Set([A, B]);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a single process leads and holds scheduler.lock; release removes it", () => {
    const a = leadership(A);
    expect(a.isLeader()).toBe(true);
    expect(a.isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(A);
    a.release();
    expect(schedulerHolder()).toBeNull();
    a.release();
  });

  it("a single process with the real pid and liveness probe leads", () => {
    const real = createSchedulerLeadership({ stateDir, telegramWanted: () => false });
    expect(real.isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(process.pid);
    real.release();
  });

  it("without Telegram the first process leads and the second waits", () => {
    const a = leadership(A);
    const b = leadership(B);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(a.isLeader()).toBe(true);
    // A exits cleanly: B takes over on its next tick.
    a.release();
    expect(b.isLeader()).toBe(true);
    expect(a.isLeader()).toBe(false);
  });

  it("takes over the lock of a holder that died without releasing", () => {
    expect(leadership(A).isLeader()).toBe(true);
    live.delete(A);
    expect(leadership(B).isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(B);
  });

  it("takes over an unreadable lock file", () => {
    writeFileSync(join(stateDir, SCHEDULER_LOCK_FILE), "garbage");
    expect(leadership(B).isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(B);
  });

  it("release never removes another process's lock", () => {
    const a = leadership(A);
    expect(a.isLeader()).toBe(true);
    leadership(B).release();
    expect(schedulerHolder()).toBe(A);
  });

  it("the Telegram owner leads even when the other process started the scheduler first", () => {
    const b = leadership(B, true);
    // B ticks first, while nobody holds telegram.lock yet: fallback lock.
    expect(b.isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(B);
    // A wins the bot.
    holdTelegram(A);
    const a = leadership(A, true);
    expect(a.isLeader()).toBe(true);
    // B wants Telegram but lost it: stands by and gives scheduler.lock up…
    expect(b.isLeader()).toBe(false);
    expect(schedulerHolder()).toBeNull();
    // …which the owner takes on its next tick.
    expect(a.isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(A);
  });

  it("a process without Telegram defers to the Telegram owner holding scheduler.lock", () => {
    holdTelegram(A);
    expect(leadership(A, true).isLeader()).toBe(true);
    expect(leadership(B, false).isLeader()).toBe(false);
  });

  it("falls back to scheduler.lock while nobody holds telegram.lock (reconnect gap or dead owner)", () => {
    const a = leadership(A, true);
    const b = leadership(B, true);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    holdTelegram(9999);
    // 9999 is not alive: same as no owner.
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
  });

  it("leadership follows telegram.lock when it moves", () => {
    const a = leadership(A, true);
    const b = leadership(B, true);
    holdTelegram(A);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    // A exits; its channel released telegram.lock and its scheduler released too.
    a.release();
    live.delete(A);
    holdTelegram(B);
    expect(b.isLeader()).toBe(true);
    expect(schedulerHolder()).toBe(B);
  });

  it("fails open when the lock cannot be created at all", () => {
    const missing = createSchedulerLeadership({
      stateDir: join(stateDir, "does-not-exist"),
      pid: A,
      isAlive: (p) => live.has(p),
      telegramWanted: () => false,
    });
    expect(missing.isLeader()).toBe(true);
    missing.release();
  });
});
