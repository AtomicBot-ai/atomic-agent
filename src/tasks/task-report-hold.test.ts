import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskReport } from "./task-report.js";
import { TaskReportHold } from "./task-report-hold.js";
import {
  HELD_REPORTS_MAX,
  SqliteHeldReportStore,
  type HeldReportStore,
  type HeldTaskReport,
} from "./task-report-hold-store.js";
import {
  isQuietAt,
  nextQuietEnd,
  parseQuietHours,
  type QuietHours,
} from "./task-report-quiet-hours.js";

const NIGHT: QuietHours = { start: "23:00", end: "08:00" };

/** Local-time date on 6 Nov 2026. */
function at(hour: number, minute = 0, day = 6): Date {
  return new Date(2026, 10, day, hour, minute, 0, 0);
}

function report(taskId: string): TaskReport {
  return {
    taskId,
    status: "completed",
    userMessage: `job ${taskId}`,
    scheduleKind: null,
    attempts: 1,
    maxAttempts: 1,
    durationMs: 1000,
    replyText: "ok",
    errorMessage: null,
    errorCategory: null,
  };
}

class MemoryStore implements HeldReportStore {
  rows: HeldTaskReport[] = [];
  private next = 1;
  add(r: TaskReport, heldAt: number): string[] {
    this.rows.push({ id: this.next++, heldAt, report: r });
    return [];
  }
  list(): HeldTaskReport[] {
    return [...this.rows];
  }
  remove(ids: readonly number[]): void {
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
  }
}

function harness(start: Date, digestOk = true) {
  let now = start;
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const direct: string[] = [];
  const digests: string[][] = [];
  let ok = digestOk;
  const store = new MemoryStore();
  const hold = new TaskReportHold({
    quietHours: NIGHT,
    store,
    deliverNow: (r) => {
      direct.push(r.taskId);
    },
    deliverDigest: async (rs) => {
      digests.push(rs.map((r) => r.taskId));
      return ok;
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    },
    retryMs: 60_000,
  });
  return {
    hold,
    store,
    direct,
    digests,
    timers,
    setNow: (d: Date) => (now = d),
    setDigestOk: (v: boolean) => (ok = v),
    /** Run the newest live timer. */
    fire: async () => {
      const t = [...timers].reverse().find((x) => !x.cancelled);
      if (!t) throw new Error("no live timer");
      t.cancelled = true;
      t.fn();
      await hold.release();
    },
  };
}

describe("quiet hours math", () => {
  it("parses HH:MM-HH:MM and rejects anything else", () => {
    expect(parseQuietHours("23:00-08:00")).toEqual(NIGHT);
    expect(parseQuietHours(" 1:30 - 6:00 ")).toEqual({ start: "1:30", end: "6:00" });
    for (const bad of [undefined, "", "23:00", "25:00-08:00", "23:00-08:60", "a-b", "1-2-3"]) {
      expect(parseQuietHours(bad), String(bad)).toBeNull();
    }
  });

  it("handles a window that wraps midnight and one that does not", () => {
    expect(isQuietAt(NIGHT, at(3))).toBe(true);
    expect(isQuietAt(NIGHT, at(23))).toBe(true);
    expect(isQuietAt(NIGHT, at(8))).toBe(false);
    expect(isQuietAt(NIGHT, at(12))).toBe(false);
    const day: QuietHours = { start: "13:00", end: "14:00" };
    expect(isQuietAt(day, at(13, 30))).toBe(true);
    expect(isQuietAt(day, at(14))).toBe(false);
    expect(isQuietAt({ start: "08:00", end: "08:00" }, at(8))).toBe(false);
  });

  it("finds the next end later today or tomorrow", () => {
    expect(nextQuietEnd(NIGHT, at(3)).getTime()).toBe(at(8).getTime());
    expect(nextQuietEnd(NIGHT, at(23, 30)).getTime()).toBe(at(8, 0, 7).getTime());
  });
});

describe("TaskReportHold", () => {
  it("passes reports straight through outside quiet hours", async () => {
    const h = harness(at(12));
    await h.hold.sink(report("a"));
    expect(h.direct).toEqual(["a"]);
    expect(h.store.rows).toHaveLength(0);
  });

  it("holds reports finished at night and releases them as one digest at the end", async () => {
    const h = harness(at(3));
    await h.hold.sink(report("a"));
    h.setNow(at(5));
    await h.hold.sink(report("b"));
    expect(h.direct).toEqual([]);
    expect(h.store.rows.map((r) => r.report.taskId)).toEqual(["a", "b"]);
    // The live timer targets 08:00 from 05:00.
    expect(h.timers.filter((t) => !t.cancelled).at(-1)?.ms).toBe(3 * 3_600_000);

    h.setNow(at(8));
    await h.fire();
    expect(h.digests).toEqual([["a", "b"]]);
    expect(h.store.rows).toHaveLength(0);
  });

  it("re-arms instead of sending when a timer fires before the window ends", async () => {
    const h = harness(at(3));
    await h.hold.sink(report("a"));
    h.setNow(at(7, 59));
    await h.fire();
    expect(h.digests).toEqual([]);
    expect(h.store.rows).toHaveLength(1);
  });

  it("keeps the reports and retries when the digest is not delivered", async () => {
    const h = harness(at(3), false);
    await h.hold.sink(report("a"));
    h.setNow(at(8));
    await h.fire();
    expect(h.store.rows).toHaveLength(1);
    expect(h.timers.filter((t) => !t.cancelled).at(-1)?.ms).toBe(60_000);

    // A report finishing while the digest is still pending joins it.
    h.setDigestOk(true);
    h.setNow(at(9));
    await h.hold.sink(report("b"));
    expect(h.direct).toEqual([]);
    expect(h.digests.at(-1)).toEqual(["a", "b"]);
    expect(h.store.rows).toHaveLength(0);
  });

  it("start() schedules the release of reports held before a restart", async () => {
    const h = harness(at(6));
    h.store.add(report("old"), at(2).getTime());
    h.hold.start();
    expect(h.timers.at(-1)?.ms).toBe(2 * 3_600_000);
    h.setNow(at(8));
    await h.fire();
    expect(h.digests).toEqual([["old"]]);
  });

  it("start() sends at once when the restart happens after the window", async () => {
    const h = harness(at(10));
    h.store.add(report("old"), at(2).getTime());
    h.hold.start();
    expect(h.timers.at(-1)?.ms).toBe(0);
  });

  it("a running agent picks up a report another process held after it started", async () => {
    const h = harness(at(3));
    h.hold.start();
    const poll = h.timers.at(-1)!;
    expect(poll.ms).toBe(5 * 60_000);

    // An `overnight` process held this one and exited.
    h.store.add(report("night"), at(5).getTime());
    h.setNow(at(5));
    poll.fn();
    const release = h.timers.find((t) => t.ms === 3 * 3_600_000);
    expect(release).toBeDefined();

    h.setNow(at(8));
    release!.fn();
    await h.hold.release();
    expect(h.digests).toEqual([["night"]]);
  });

  it("the check re-arms itself and does nothing while no report is held", () => {
    const h = harness(at(3));
    h.hold.start();
    h.timers.at(-1)!.fn();
    expect(h.timers).toHaveLength(2);
    expect(h.timers.at(-1)?.ms).toBe(5 * 60_000);
  });

  it("stop() ends the check for held reports", () => {
    const h = harness(at(3));
    h.hold.start();
    h.hold.stop();
    expect(h.timers.every((t) => t.cancelled)).toBe(true);
  });

  it("stop() cancels the pending release", async () => {
    const h = harness(at(3));
    await h.hold.sink(report("a"));
    h.hold.stop();
    expect(h.timers.every((t) => t.cancelled)).toBe(true);
  });
});

describe("SqliteHeldReportStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "held-reports-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives a reopen (restart) and removes delivered rows", () => {
    const file = join(dir, "tasks.sqlite");
    const first = new SqliteHeldReportStore({ dbFile: file });
    first.add(report("a"), 1);
    first.add(report("b"), 2);
    first.close();

    const second = new SqliteHeldReportStore({ dbFile: file });
    const rows = second.list();
    expect(rows.map((r) => r.report.taskId)).toEqual(["a", "b"]);
    expect(rows[0]?.report).toEqual(report("a"));
    second.remove([rows[0]!.id]);
    expect(second.list().map((r) => r.report.taskId)).toEqual(["b"]);
    second.close();
  });

  it("drops the oldest past the cap and says which", () => {
    const store = new SqliteHeldReportStore({ dbFile: join(dir, "tasks.sqlite") });
    for (let i = 0; i < HELD_REPORTS_MAX; i += 1) store.add(report(`t${i}`), i);
    expect(store.add(report("overflow"), 999)).toEqual(["t0"]);
    expect(store.list()).toHaveLength(HELD_REPORTS_MAX);
    store.close();
  });
});
