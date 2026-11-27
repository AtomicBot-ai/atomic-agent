import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DrainOutcome } from "../tasks/task-runner.js";
import { createFileTriggerClaims, type FileTriggerClaims } from "./file-trigger-claims.js";
import { FileTriggerManager } from "./file-trigger-manager.js";
import { Scheduler, type SchedulerClock } from "./scheduler.js";
import type { SchedulerLeadership } from "./scheduler-leadership.js";
import { fakeWatcherFactory, manualClock, memoryFs, recorder, triggerConfig } from "./file-trigger-test-helpers.js";

// ATO-2508: two processes on one state dir around a leadership
// hand-over. The new leader starts its watchers on the tick it takes
// the lock; the old one closes its own only on its next tick. A file
// written in between must file one task, not two.

const HOME = resolve("/home/user");
const INBOX = join(HOME, "Inbox");
const outcome: DrainOutcome = { drained: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, retried: 0 };
const settle = () => new Promise<void>((done) => setImmediate(done));

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "file-trigger-handover-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function world() {
  const disk = memoryFs();
  disk.dirs.add(INBOX);
  const time = manualClock();
  const holder = { pid: "A" };
  const definitions = { inbox: triggerConfig({ path: "~/Inbox", events: ["add"] }) };

  const processOn = (pid: string, claims: FileTriggerClaims) => {
    const handlers: Array<() => void> = [];
    const clock: SchedulerClock = {
      now: () => 0,
      setInterval: (handler) => handlers.push(handler),
      clearInterval: () => {},
    };
    const { factory, watches } = fakeWatcherFactory();
    const out = recorder();
    let scheduler: Scheduler | null = null;
    const manager = new FileTriggerManager({
      definitions, factory, fs: disk.fs, clock: time.clock, homeDir: HOME, fire: out.fire,
      confirmLeader: () => scheduler?.confirmLeadership() ?? false,
      claims,
    });
    const leadership: SchedulerLeadership = { isLeader: () => holder.pid === pid, release: () => {} };
    scheduler = new Scheduler({
      taskRunner: { runDue: vi.fn().mockResolvedValue(outcome) },
      tickMs: 5_000, batch: 1, clock, leadership,
      onLeadershipChange: (leading) => manager.setLeader(leading),
    });
    scheduler.start();
    return { scheduler, manager, watches, out, tick: () => handlers[0]!() };
  };
  return { disk, time, holder, processOn };
}

describe("file triggers across a leadership hand-over (ATO-2508)", () => {
  it("files one task for a file written before the old leader's next tick", async () => {
    const w = world();
    const a = w.processOn("A", createFileTriggerClaims({ stateDir }));
    const b = w.processOn("B", createFileTriggerClaims({ stateDir }));
    a.tick();
    b.tick();
    await settle();
    expect(a.watches).toHaveLength(1);
    expect(b.watches).toHaveLength(0);
    a.watches[0]!.listeners.onReady();

    // B takes the lock (the Telegram owner claiming scheduler.lock) and
    // starts watching on that same tick; A has not ticked since.
    w.holder.pid = "B";
    b.tick();
    await settle();
    expect(b.watches).toHaveLength(1);
    b.watches[0]!.listeners.onReady();
    expect(a.watches[0]!.closed).toBe(false);

    const pdf = join(INBOX, "scan.pdf");
    w.disk.write(pdf, "%PDF");
    const aWatcher = a.manager.watcher("inbox")!;
    const bWatcher = b.manager.watcher("inbox")!;
    a.watches[0]!.listeners.onEvent("add", pdf);
    b.watches[0]!.listeners.onEvent("add", pdf);
    w.time.flush();
    await aWatcher.whenIdle();
    await bWatcher.whenIdle();
    await settle();

    expect(a.out.fired).toEqual([]);
    expect(b.out.fired.map((f) => f.userMessage)).toEqual(["add scan.pdf"]);
    // A stood by on the hit itself, not on its next tick.
    expect(a.watches[0]!.closed).toBe(true);
    await a.scheduler.stop();
    await b.scheduler.stop();
  });

  it("the shared claim keeps one task when both processes still pass the leadership check", async () => {
    const w = world();
    const make = () => {
      const { factory, watches } = fakeWatcherFactory();
      const out = recorder();
      const manager = new FileTriggerManager({
        definitions: { inbox: triggerConfig({ path: "~/Inbox", events: ["add"] }) },
        factory, fs: w.disk.fs, clock: w.time.clock, homeDir: HOME, fire: out.fire,
        confirmLeader: () => true,
        claims: createFileTriggerClaims({ stateDir }),
      });
      return { manager, watches, out };
    };
    const a = make();
    const b = make();
    await a.manager.setLeader(true);
    await b.manager.setLeader(true);
    a.watches[0]!.listeners.onReady();
    b.watches[0]!.listeners.onReady();
    const pdf = join(INBOX, "scan.pdf");
    w.disk.write(pdf, "%PDF");
    a.watches[0]!.listeners.onEvent("add", pdf);
    b.watches[0]!.listeners.onEvent("add", pdf);
    w.time.flush();
    await a.manager.watcher("inbox")!.whenIdle();
    await b.manager.watcher("inbox")!.whenIdle();
    expect(a.out.fired.length + b.out.fired.length).toBe(1);

    // A later write is a new hit and fires again, once.
    w.disk.write(pdf, "%PDF-2");
    a.watches[0]!.listeners.onEvent("add", pdf);
    b.watches[0]!.listeners.onEvent("add", pdf);
    w.time.flush();
    await a.manager.watcher("inbox")!.whenIdle();
    await b.manager.watcher("inbox")!.whenIdle();
    expect(a.out.fired.length + b.out.fired.length).toBe(2);
  });
});
