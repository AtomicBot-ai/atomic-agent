import { describe, expect, it } from "vitest";

import {
  TaskValidationError,
  resolveScheduledFor,
  type TaskPauseResult,
  type TaskRecord,
  type TaskSchedule,
} from "../../tasks/index.js";

import {
  formatWhen,
  resolveId,
  runCronCommand,
  shortId,
  type CronCreateInput,
  type CronTaskService,
} from "./cron-command.js";

const OWNER = 42;
const STRANGER = 99;
const NOW = Date.UTC(2026, 10, 12, 8, 30);

function record(over: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    sessionId: "s-1",
    userMessage: "morning digest",
    maxSteps: null,
    status: "pending",
    origin: "telegram",
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    lastErrorCategory: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    schedule: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
    scheduledFor: Date.UTC(2026, 10, 12, 9, 0),
    recurring: true,
    lastScheduledAt: NOW,
    triggerSource: "user",
    notify: "telegram",
    maxCostUsd: null,
    maxDurationMs: null,
    spentUsd: null,
    elapsedMs: null,
    stopCause: null,
    ...over,
  };
}

/** In-memory stand-in for the runtime's queue: records what the command asked for. */
function fakeService(initial: TaskRecord[] = [], schedulerRunning = true) {
  const tasks = [...initial];
  const created: CronCreateInput[] = [];
  const calls: string[] = [];
  let seq = 0;
  const find = (id: string) => tasks.find((t) => t.id === id) ?? null;
  const replace = (next: TaskRecord) => {
    tasks[tasks.findIndex((t) => t.id === next.id)] = next;
    return next;
  };
  const service: CronTaskService & { failCreateWith?: Error } = {
    schedulerRunning,
    list: () => [...tasks],
    create: (input) => {
      if (service.failCreateWith) throw service.failCreateWith;
      created.push(input);
      const schedule: TaskSchedule = {
        kind: "cron",
        expression: input.expression,
        ...(input.tz ? { tz: input.tz } : {}),
      };
      const task = record({
        id: `t-0000000${seq++}-aaaa-bbbb-cccc-dddddddddddd`,
        userMessage: input.message,
        schedule,
        scheduledFor: resolveScheduledFor(schedule, NOW),
      });
      tasks.unshift(task);
      return task;
    },
    pause: (id): TaskPauseResult => {
      calls.push(`pause ${id}`);
      const t = find(id)!;
      if (t.status === "running") return { ok: false, reason: "running", task: t };
      if (t.status === "paused") return { ok: false, reason: "already_paused", task: t };
      return { ok: true, task: replace({ ...t, status: "paused" }) };
    },
    resume: (id): TaskPauseResult => {
      calls.push(`resume ${id}`);
      const t = find(id)!;
      if (t.status !== "paused") return { ok: false, reason: "not_paused", task: t };
      return {
        ok: true,
        task: replace({ ...t, status: "pending", lastError: null, scheduledFor: Date.UTC(2026, 10, 13, 9, 0) }),
      };
    },
    remove: (id): TaskPauseResult => {
      calls.push(`remove ${id}`);
      return { ok: true, task: replace({ ...find(id)!, status: "cancelled" }) };
    },
  };
  return { service, created, calls, tasks };
}

function run(args: string, service: CronTaskService | null, senderId = OWNER): string {
  return runCronCommand(args, { service, senderId, ownerUserId: OWNER, now: () => NOW });
}

const A = "t-1a2b3c4d-1111-2222-3333-444444444444";
const B = "t-1a2b9999-1111-2222-3333-444444444444";
const C = "t-77777777-1111-2222-3333-444444444444";

describe("runCronCommand owner check", () => {
  it("refuses anyone but the owner, before touching the queue", () => {
    const { service, created, calls } = fakeService([record({ id: A })]);
    for (const args of ["", "add 0 9 * * * x", `pause ${A}`, `delete ${A}`]) {
      expect(run(args, service, STRANGER)).toContain("Only the owner");
    }
    expect(created).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("refuses everyone while no owner is paired", () => {
    const { service } = fakeService();
    expect(runCronCommand("", { service, senderId: OWNER, ownerUserId: null })).toContain(
      "Only the owner",
    );
  });
});

describe("/cron add", () => {
  it("creates a cron task through the service and says when it runs next", () => {
    const { service, created } = fakeService();
    const reply = run("add --tz UTC 0 9 * * * summarise my inbox", service);
    expect(created).toEqual([{ expression: "0 9 * * *", tz: "UTC", message: "summarise my inbox" }]);
    expect(reply).toContain("Scheduled t-00000000: 0 9 * * * (UTC)");
    expect(reply).toContain("Next run: 2026-11-12 09:00 UTC");
    expect(reply).toContain("comes back to your private chat");
    expect(reply).toContain("/cron pause t-00000000");
  });

  it("rejects an invalid cron with the core parser's reason and creates nothing", () => {
    const { service, created } = fakeService();
    const reply = run("add 61 9 * * * x", service);
    expect(reply).toContain('Not scheduled: "61 9 * * *" is not a valid cron');
    expect(reply).toContain("invalid cron expression");
    expect(created).toHaveLength(0);
  });

  it("rejects an unknown time zone", () => {
    const { service, created } = fakeService();
    const reply = run("add --tz Mars/Olympus 0 9 * * * x", service);
    expect(reply).toContain("Not scheduled");
    expect(created).toHaveLength(0);
  });

  it("passes a validation error from the queue back as text", () => {
    const { service } = fakeService();
    service.failCreateWith = new TaskValidationError("userMessage", "userMessage is too long");
    expect(run("add 0 9 * * * x", service)).toBe("Not scheduled: userMessage is too long.");
  });

  it("warns when the scheduler is off", () => {
    const { service } = fakeService([], false);
    expect(run("add 0 9 * * * x", service)).toContain("scheduler is off");
  });

  it("explains a usage error without creating anything", () => {
    const { service, created } = fakeService();
    expect(run("add 0 9 * * *", service)).toContain("Say what the task should do");
    expect(created).toHaveLength(0);
  });
});

describe("/cron list", () => {
  it("shows only scheduled tasks that can still fire, with their state", () => {
    const { service } = fakeService([
      record({ id: A, userMessage: "digest" }),
      record({ id: B, status: "paused", userMessage: "paused one" }),
      record({ id: C, status: "running", userMessage: "busy one" }),
      record({ id: "t-done0000", status: "cancelled" }),
      record({ id: "t-oneshot0", recurring: false, schedule: null, scheduledFor: null }),
      record({ id: "t-blocked0", status: "blocked", lastError: "session missing" }),
    ]);
    const reply = run("", service);
    expect(reply).toContain("Scheduled tasks (3):");
    expect(reply).toContain("t-1a2b3c4d · 0 9 * * * (UTC) · next 2026-11-12 09:00 UTC");
    expect(reply).toContain("t-1a2b9999 · 0 9 * * * (UTC) · Paused");
    expect(reply).toContain("t-77777777 · 0 9 * * * (UTC) · running now");
    expect(reply).not.toContain("t-done0000");
    expect(reply).not.toContain("t-oneshot0");
    expect(reply).not.toContain("t-blocked0");
  });

  it("says so when there are none", () => {
    expect(run("list", fakeService().service)).toContain("No scheduled tasks.");
  });

  it("answers when the runtime has no task queue", () => {
    expect(run("list", null)).toContain("not available");
  });
});

describe("/cron pause, resume, delete", () => {
  it("pauses by a unique short id", () => {
    const { service, calls } = fakeService([record({ id: A }), record({ id: C })]);
    expect(run("pause 7777", service)).toBe(
      "Paused t-77777777. It will not run until /cron resume t-77777777.",
    );
    expect(calls).toEqual([`pause ${C}`]);
  });

  it("refuses to pause a running task", () => {
    const { service } = fakeService([record({ id: C, status: "running" })]);
    expect(run(`pause ${C}`, service)).toContain("running right now");
  });

  it("resumes a paused task and says when it runs next", () => {
    const { service, calls } = fakeService([
      record({ id: A, status: "paused" }),
    ]);
    expect(run("resume t-1a2b3c4d", service)).toBe(
      "Resumed t-1a2b3c4d. Next run: 2026-11-13 09:00 UTC",
    );
    expect(calls).toEqual([`resume ${A}`]);
  });

  it("refuses to resume a task that is not paused", () => {
    const { service } = fakeService([record({ id: A })]);
    expect(run(`resume ${A}`, service)).toBe("t-1a2b3c4d is not paused.");
  });

  it("deletes by id", () => {
    const { service, calls, tasks } = fakeService([record({ id: A })]);
    expect(run(`delete ${A}`, service)).toBe("Deleted t-1a2b3c4d. It will not run again.");
    expect(calls).toEqual([`remove ${A}`]);
    expect(tasks[0]!.status).toBe("cancelled");
  });

  it("refuses an ambiguous, too short or unknown id without calling the queue", () => {
    const { service, calls } = fakeService([record({ id: A }), record({ id: B })]);
    expect(run("delete 1a2b", service)).toContain("matches 2 tasks");
    expect(run("delete 1a", service)).toContain("at least 4 characters");
    expect(run("delete ffff", service)).toContain("No scheduled task ffff");
    expect(calls).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("shortId keeps t- plus 8 characters", () => {
    expect(shortId(A)).toBe("t-1a2b3c4d");
    expect(shortId("custom")).toBe("custom");
  });

  it("resolveId matches the full id case-insensitively", () => {
    expect(resolveId(A.toUpperCase().replace("T-", "t-"), [record({ id: A })])).toEqual({ id: A });
  });

  it("formatWhen prints the schedule's zone", () => {
    expect(formatWhen(Date.UTC(2026, 10, 13, 9, 0), "UTC")).toBe("2026-11-13 09:00 UTC");
  });
});
