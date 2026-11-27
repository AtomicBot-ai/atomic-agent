import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_LOGBOOK_SETTINGS, type LogbookSettings } from "./logbook-settings.js";
import { readStandupState, reconcileStandup, standupCron, type StandupTasks } from "./logbook-standup.js";

/** ATO-2526: the morning standup is one cron task that follows the settings. */
function tasks() {
  const live = new Set<string>();
  const created: string[] = [];
  const cancelled: string[] = [];
  let n = 0;
  const api: StandupTasks = {
    createDaily: (cron) => {
      const id = `task-${++n}`;
      live.add(id);
      created.push(`${id} ${cron}`);
      return id;
    },
    cancel: (id) => {
      live.delete(id);
      cancelled.push(id);
    },
    isLive: (id) => live.has(id),
  };
  return { api, created, cancelled, live };
}

const on = (standupAt: string | null): LogbookSettings => ({ ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], titleOnlyApps: [], enabled: true, standupAt });

describe("morning standup", () => {
  it("turns HH:MM into a daily cron, minute first", () => {
    expect(standupCron("09:05")).toBe("5 9 * * *");
    expect(standupCron("18:30")).toBe("30 18 * * *");
  });

  it("files nothing while it is off (the default)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-standup-"));
    const t = tasks();
    expect(reconcileStandup(dir, on(null), t.api, "standup")).toBe("none");
    expect(t.created).toEqual([]);
  });

  it("files one task, keeps it, replaces it when the time changes and cancels it when off", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-standup-"));
    const t = tasks();
    expect(reconcileStandup(dir, on("09:00"), t.api, "standup")).toBe("created");
    expect(reconcileStandup(dir, on("09:00"), t.api, "standup")).toBe("none");
    expect(t.created).toEqual(["task-1 0 9 * * *"]);
    expect(reconcileStandup(dir, on("08:30"), t.api, "standup")).toBe("replaced");
    expect(t.cancelled).toEqual(["task-1"]);
    expect(readStandupState(dir)).toEqual({ taskId: "task-2", at: "08:30" });
    expect(reconcileStandup(dir, on(null), t.api, "standup")).toBe("cancelled");
    expect(t.live.size).toBe(0);
  });

  it("cancels it when the logbook is stopped", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-standup-"));
    const t = tasks();
    reconcileStandup(dir, on("09:00"), t.api, "standup");
    expect(reconcileStandup(dir, { ...on("09:00"), enabled: false }, t.api, "standup")).toBe("cancelled");
  });

  it("does not file again a task the person cancelled in the task list, until the time changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-standup-"));
    const t = tasks();
    reconcileStandup(dir, on("09:00"), t.api, "standup");
    t.live.clear();
    expect(reconcileStandup(dir, on("09:00"), t.api, "standup")).toBe("none");
    expect(t.created).toHaveLength(1);
    expect(reconcileStandup(dir, on("10:00"), t.api, "standup")).toBe("created");
    expect(t.created).toHaveLength(2);
  });
});
