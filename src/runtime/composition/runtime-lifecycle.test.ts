import { describe, expect, it } from "vitest";
import { createRuntimeLifecycle, type RuntimeLifecycleResources } from "./runtime-lifecycle.js";

function fixture(events: string[], schedulerStopped: Promise<void> = Promise.resolve()) {
  const naming = new AbortController();
  naming.signal.addEventListener("abort", () => events.push("naming.abort"));
  const pending = new Set([naming]);
  const close = (name: string) => ({ close: () => { events.push(`${name}.close`); } });
  const resources: RuntimeLifecycleResources = {
    sessionStore: {
      releaseOwnTurns: (_ending, options) => { events.push(options?.keepMarks ? "release.standin" : "release.final"); return 0; },
      ...close("session"),
    },
    logger: { warn: (message) => { events.push(`warn:${message}`); } },
    steeringInbox: { clearAll: () => { events.push("steering.clear"); } },
    shellJobs: { endAll: () => { events.push("shell.endAll"); return []; } },
    reflectionRunner: { abortPending: () => { events.push("reflection.abort"); } },
    pendingSessionNamings: pending,
    turnsInFlight: { settleCancelled: async (grace) => { events.push(`turns.settle:${grace}`); return 0; } },
    browserBackend: { shutdown: async () => { events.push("browser.stop"); } },
    mcpManager: { shutdown: async () => { events.push("mcp.stop"); } },
    profileStore: close("profile"), notesStore: close("notes"),
    lessonStore: close("lesson"), procedureStore: close("procedure"),
    taskStore: close("task"),
    taskRunner: { stop: async (grace) => { events.push(`tasks.stop:${grace}`); return 0; } },
    scheduler: { stop: (grace) => { events.push(`scheduler.stop:${grace}`); return schedulerStopped; } },
    telegramChannelForShutdown: { stop: async () => { events.push("telegram.stop"); } },
    discordChannelForShutdown: { stop: async () => { events.push("discord.stop"); } },
    swarmForShutdown: { stopAll: async () => { events.push("swarm.stop"); } },
    consolidatorJob: { stop: async () => { events.push("consolidator.stop"); } },
    analytics: { shutdown: async () => { events.push("analytics.stop"); } },
    errorReporter: { shutdown: async () => { events.push("reporter.stop"); } },
  };
  return { resources, pending, naming };
}

const order = [
  "release.standin", "tasks.stop:1500", "scheduler.stop:1500", "steering.clear", "shell.endAll",
  "reflection.abort", "naming.abort", "telegram.stop", "discord.stop",
  "swarm.stop", "mcp.stop", "browser.stop", "turns.settle:1500",
  "release.final", "session.close", "profile.close", "lesson.close",
  "procedure.close", "notes.close", "consolidator.stop", "task.close",
  "analytics.stop", "reporter.stop",
];

describe("runtime lifecycle ownership", () => {
  it("preserves ordered teardown and reads resources connected after construction", async () => {
    const events: string[] = [];
    const { resources, naming, pending } = fixture(events);
    let connected = false;
    const lifecycle = createRuntimeLifecycle({
      ...resources,
      get scheduler() { return connected ? resources.scheduler : null; },
      get telegramChannelForShutdown() { return connected ? resources.telegramChannelForShutdown : null; },
      get consolidatorJob() { return connected ? resources.consolidatorJob : null; },
      get analytics() { return connected ? resources.analytics : null; },
      get errorReporter() { return connected ? resources.errorReporter : null; },
    });
    expect(lifecycle.isShutdown()).toBe(false);
    connected = true;
    await lifecycle.shutdown();
    expect(events).toEqual(order);
    expect(naming.signal.aborted).toBe(true);
    expect(pending.size).toBe(0);
    expect(lifecycle.isShutdown()).toBe(true);
    await lifecycle.shutdown();
    expect(events).toEqual(order);
  });

  it("keeps the existing scheduler drain position and immediate second-shutdown return", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const schedulerStopped = new Promise<void>((resolve) => { release = resolve; });
    const { resources } = fixture(events, schedulerStopped);
    let storesClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => { storesClosed = resolve; });
    const lifecycle = createRuntimeLifecycle({ ...resources, notesStore: { close: () => { resources.notesStore.close(); storesClosed(); } } });
    const first = lifecycle.shutdown();
    await closed;
    expect(events).toEqual(order.slice(0, 19));
    await lifecycle.shutdown();
    expect(events).toEqual(order.slice(0, 19));
    release();
    await first;
    expect(events).toEqual(order);
  });

  it("continues best-effort cleanup after channel/store errors without a borrowed-handle close", async () => {
    const events: string[] = [];
    const { resources } = fixture(events);
    const lifecycle = createRuntimeLifecycle({
      ...resources,
      telegramChannelForShutdown: { stop: async () => { events.push("telegram.stop"); throw new Error("offline"); } },
      profileStore: { close: () => { events.push("profile.close"); throw new Error("closed"); } },
      turnsInFlight: { settleCancelled: async (grace) => { events.push(`turns.settle:${grace}`); return 2; } },
    });
    await lifecycle.shutdown();
    expect(events.filter((event) => !event.startsWith("warn:"))).toEqual(order);
    expect(events.filter((event) => event.startsWith("warn:"))).toEqual([
      "warn:telegram: shutdown failed", "warn:stopped turns still running at shutdown; recorded as interrupted",
    ]);
  });

  it("waits for the bounded task stop before closing its store and reports unfinished runs", async () => {
    const events: string[] = [];
    const { resources } = fixture(events);
    let stopped: (count: number) => void = () => {};
    const taskRunsStopped = new Promise<number>((resolve) => { stopped = resolve; });
    let closed: () => void = () => {};
    const storesClosed = new Promise<void>((resolve) => { closed = resolve; });
    const lifecycle = createRuntimeLifecycle({
      ...resources,
      taskRunner: { stop: (grace) => { events.push(`tasks.stop:${grace}`); return taskRunsStopped; } },
      notesStore: { close: () => { resources.notesStore.close(); closed(); } },
    });
    const shutdown = lifecycle.shutdown();
    await storesClosed;
    expect(events).not.toContain("task.close");
    stopped(2);
    await shutdown;
    expect(events).toContain("warn:task runs still going at shutdown; left for the next boot");
    expect(events.indexOf("task.close")).toBeGreaterThan(events.indexOf("warn:task runs still going at shutdown; left for the next boot"));
  });

  it("warns for rejected task and scheduler stops while completing cleanup", async () => {
    const events: string[] = [];
    const { resources } = fixture(events);
    const lifecycle = createRuntimeLifecycle({
      ...resources,
      taskRunner: { stop: async (grace) => { events.push(`tasks.stop:${grace}`); throw new Error("task stop failed"); } },
      scheduler: { stop: async (grace) => { events.push(`scheduler.stop:${grace}`); throw new Error("scheduler stop failed"); } },
    });
    await lifecycle.shutdown();
    expect(events.filter((event) => !event.startsWith("warn:"))).toEqual(order);
    expect(events.filter((event) => event.startsWith("warn:"))).toEqual([
      "warn:stopping task runs failed", "warn:scheduler stop failed",
    ]);
  });

});
