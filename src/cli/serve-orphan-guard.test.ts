import { afterEach, describe, expect, it, vi } from "vitest";

import { isAlive, watchForOrphaning } from "./serve-orphan-guard.js";

/**
 * A pid that cannot exist: macOS caps at 99998 and Linux's default
 * `pid_max` is 32768, so this is `ESRCH` everywhere we ship.
 */
const DEAD_PID = 999_999;

/** Let the watch's interval fire at least once. */
function tick(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * `process.ppid` is a writable data property, so a test can move it to
 * imitate the kernel reparenting this process. Restored after each test.
 */
const REAL_PPID = process.ppid;
function setPpid(value: number): void {
  Object.defineProperty(process, "ppid", {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
afterEach(() => setPpid(REAL_PPID));

describe("isAlive", () => {
  it("sees this process and not a pid that cannot exist", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(DEAD_PID)).toBe(false);
  });
});

describe("watchForOrphaning", () => {
  it("does nothing when the parent is already init — launchd/systemd are not orphans", async () => {
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({ parentPid: 1, intervalMs: 5, onOrphaned });
    await tick(40);
    stop();
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it("stays quiet while the real parent is alive and still ours", async () => {
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({ intervalMs: 5, onOrphaned });
    await tick(40);
    stop();
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  // The two ways abandonment is detected are a disjunction, so each one
  // needs a case the other cannot explain — otherwise either arm could
  // be deleted with the suite still green.

  it("fires on reparenting alone, while the watched pid is still alive", async () => {
    // Watching our own (live) parent, then the kernel moves us. Liveness
    // still passes, so only the reparenting arm can explain this firing.
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({ intervalMs: 5, onOrphaned });
    expect(isAlive(REAL_PPID)).toBe(true);
    setPpid(1);
    await tick(40);
    stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("fires on the watched pid dying alone, with no reparenting", async () => {
    // An explicit --parent-pid is never compared against process.ppid,
    // so only the liveness arm can explain this firing.
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({
      parentPid: DEAD_PID,
      intervalMs: 5,
      onOrphaned,
    });
    await tick(40);
    stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for a live --parent-pid that is not our own parent", async () => {
    // The whole point of --parent-pid is a spawner that double-forks,
    // where process.ppid is the intermediate and the watched pid is the
    // grandparent. Reading that mismatch as abandonment would shut the
    // server down seconds after boot, every single time.
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({
      parentPid: process.pid, // alive, and deliberately != process.ppid
      intervalMs: 5,
      onOrphaned,
    });
    await tick(60);
    stop();
    expect(process.pid).not.toBe(process.ppid);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it("fires exactly once, however long it keeps running", async () => {
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({
      parentPid: DEAD_PID,
      intervalMs: 5,
      onOrphaned,
    });
    await tick(60);
    stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("keeps a busy orphan alive, and closes it the moment the turn lands", async () => {
    const onOrphaned = vi.fn();
    const onOrphanedWhileBusy = vi.fn();
    let busy = true;
    const stop = watchForOrphaning({
      parentPid: DEAD_PID,
      intervalMs: 5,
      isBusy: () => busy,
      onOrphaned,
      onOrphanedWhileBusy,
    });

    await tick(40);
    // Abandoned for several ticks, but a turn is in flight: the server
    // keeps serving and says so once, not once per tick.
    expect(onOrphaned).not.toHaveBeenCalled();
    expect(onOrphanedWhileBusy).toHaveBeenCalledTimes(1);

    busy = false;
    await tick(40);
    stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    expect(onOrphanedWhileBusy).toHaveBeenCalledTimes(1);
  });

  it("stops watching when told to", async () => {
    const onOrphaned = vi.fn();
    const stop = watchForOrphaning({
      parentPid: DEAD_PID,
      intervalMs: 20,
      onOrphaned,
    });
    stop();
    await tick(60);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it("never holds the event loop open on its own account", () => {
    // An un-unref'd interval would keep `serve` alive after everything
    // else had finished, which is the opposite of this module's job.
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    try {
      watchForOrphaning({ parentPid: DEAD_PID, intervalMs: 5, onOrphaned: vi.fn() });
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
