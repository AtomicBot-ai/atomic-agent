import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";

import type { HeartbeatConfig, HeartbeatOutcome } from "./task-heartbeat.js";
import type { HeartbeatStore } from "./task-heartbeat-store.js";
import type { TaskReport } from "./task-report.js";
import { TaskRunner } from "./task-runner.js";
import type { TaskRunnerRuntime } from "./task-runner.js";
import { TaskStore } from "./task-store.js";

/**
 * Heartbeats in the runner (ATO-454): a `NO_REPLY` answer is not
 * delivered anywhere, news is, and a firing outside the active hours or
 * with an empty checklist runs no turn at all.
 */

class MemoryHeartbeatStore implements HeartbeatStore {
  readonly configs = new Map<string, HeartbeatConfig>();
  readonly outcomes: Array<{ taskId: string; outcome: HeartbeatOutcome }> = [];
  get(taskId: string): HeartbeatConfig | null {
    return this.configs.get(taskId) ?? null;
  }
  recordOutcome(taskId: string, outcome: HeartbeatOutcome): void {
    this.outcomes.push({ taskId, outcome });
  }
}

describe("TaskRunner heartbeats", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;
  let heartbeats: MemoryHeartbeatStore;
  let reports: TaskReport[];
  let desktop: Array<{ title: string; message: string }>;
  let messages: string[];
  let hookPassed: boolean[];
  let checklist: string | null;
  let now: Date;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-runner-heartbeat-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-heartbeat", workingDir: "/tmp/work" });
    heartbeats = new MemoryHeartbeatStore();
    reports = [];
    desktop = [];
    messages = [];
    hookPassed = [];
    checklist = "- check the build";
    now = new Date(2026, 10, 12, 10, 0, 0, 0);
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function runnerReplying(reply: string): TaskRunner {
    const runtime: TaskRunnerRuntime = {
      runTurn: async (s, message, options) => {
        messages.push(message);
        hookPassed.push(options?.eventHook !== undefined);
        options?.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: reply },
        });
        return { session: s, reason: "reply", stepCount: 1 };
      },
    };
    return new TaskRunner({
      store,
      runtime,
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
      reportSink: (report) => {
        reports.push(report);
      },
      heartbeat: {
        store: heartbeats,
        readChecklist: () => checklist,
        notifyDesktop: (title, message) => {
          desktop.push({ title, message });
        },
        now: () => now,
      },
    });
  }

  function createHeartbeat(
    extra: Partial<HeartbeatConfig> = {},
    notify: "telegram" | null = "telegram",
  ): string {
    const task = store.create({
      sessionId: session.id,
      userMessage: "Heartbeat check: go through the checklist in /state/HEARTBEAT.md",
      origin: "cli",
      maxAttempts: 1,
      notify,
      schedule: { kind: "interval", everyMs: 30 * 60_000 },
      scheduledFor: 0,
    });
    heartbeats.configs.set(task.id, {
      taskId: task.id,
      checklistPath: "/state/HEARTBEAT.md",
      activeHours: null,
      osNotify: true,
      ...extra,
    });
    return task.id;
  }

  /** Let fire-and-forget sinks settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("runs the turn on the checklist prompt, not the stored message", async () => {
    const runner = runnerReplying("NO_REPLY");
    const id = createHeartbeat();
    await runner.runOne(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("- check the build");
    expect(messages[0]).toContain("NO_REPLY");
  });

  it("delivers nothing for a NO_REPLY run and records nothing new", async () => {
    const runner = runnerReplying("**NO_REPLY**.");
    const id = createHeartbeat();
    const final = await runner.runOne(id);
    await settle();
    expect(reports).toHaveLength(0);
    expect(desktop).toHaveLength(0);
    expect(heartbeats.outcomes).toEqual([{ taskId: id, outcome: "nothing_new" }]);
    // Requeued for the next firing like any recurring task.
    expect(final?.status).toBe("pending");
  });

  it("delivers news to Telegram and the desktop", async () => {
    const runner = runnerReplying("The nightly build failed.");
    const id = createHeartbeat();
    await runner.runOne(id);
    await settle();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: id, replyText: "The nightly build failed." });
    expect(desktop).toEqual([{ title: "Atomic Agent", message: "The nightly build failed." }]);
    expect(heartbeats.outcomes).toEqual([{ taskId: id, outcome: "delivered" }]);
  });

  it("collects the reply of a heartbeat without a Telegram target and notifies only the desktop", async () => {
    const runner = runnerReplying("Disk is almost full.");
    const id = createHeartbeat({}, null);
    await runner.runOne(id);
    await settle();
    expect(hookPassed).toEqual([true]);
    expect(reports).toHaveLength(0);
    expect(desktop).toHaveLength(1);
  });

  it("does not notify the desktop unless the heartbeat asks for it", async () => {
    const runner = runnerReplying("Disk is almost full.");
    const id = createHeartbeat({ osNotify: false });
    await runner.runOne(id);
    await settle();
    expect(reports).toHaveLength(1);
    expect(desktop).toHaveLength(0);
  });

  it("runs no turn outside the active hours and requeues", async () => {
    now = new Date(2026, 10, 12, 3, 0, 0, 0);
    const runner = runnerReplying("should not run");
    const id = createHeartbeat({ activeHours: { start: "08:00", end: "22:00" } });
    const final = await runner.runOne(id);
    await settle();
    expect(messages).toHaveLength(0);
    expect(reports).toHaveLength(0);
    expect(final?.status).toBe("pending");
    expect(final?.scheduledFor).toBeGreaterThan(0);
    expect(heartbeats.outcomes).toEqual([{ taskId: id, outcome: "outside_active_hours" }]);
  });

  it("runs inside the active hours", async () => {
    const runner = runnerReplying("NO_REPLY");
    const id = createHeartbeat({ activeHours: { start: "08:00", end: "22:00" } });
    await runner.runOne(id);
    expect(messages).toHaveLength(1);
  });

  it("runs no turn while the checklist is empty or missing", async () => {
    const runner = runnerReplying("should not run");
    checklist = "   \n";
    const empty = createHeartbeat();
    await runner.runOne(empty);
    checklist = null;
    const missing = createHeartbeat();
    await runner.runOne(missing);
    expect(messages).toHaveLength(0);
    expect(heartbeats.outcomes.map((o) => o.outcome)).toEqual(["no_checklist", "no_checklist"]);
  });

  it("leaves an interval task without heartbeat settings alone", async () => {
    const runner = runnerReplying("NO_REPLY");
    const task = store.create({
      sessionId: session.id,
      userMessage: "plain recurring",
      origin: "cli",
      maxAttempts: 1,
      notify: "telegram",
      schedule: { kind: "interval", everyMs: 60_000 },
      scheduledFor: 0,
    });
    await runner.runOne(task.id);
    await settle();
    expect(messages).toEqual(["plain recurring"]);
    // An ordinary task reports whatever it replied, sentinel or not.
    expect(reports).toHaveLength(1);
    expect(heartbeats.outcomes).toHaveLength(0);
  });
});
