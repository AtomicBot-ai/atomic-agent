import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, type AgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import {
  INTERRUPTED_TURN_ENDING,
  SessionStore,
  hostIdentity,
  hostUptime,
} from "../session/index.js";
import {
  TASK_INTERRUPTED_ERROR,
  TASK_OWNER_GONE_ERROR,
  TaskStore,
} from "../tasks/index.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";

/**
 * A scheduled task's run, from the agent's side of a restart (ATO-174).
 *
 * Seen in a user's `tasks.sqlite`: "hello every 5m" stayed `running` for
 * good. The agent was stopped while the task's turn waited on the model
 * server — `serve` did not stop that turn on SIGTERM and waited on it,
 * until the desktop killed the agent — and the agent that started 4 s
 * later only took back `running` tasks older than five minutes.
 */

/** How long the desktop's stop waits after SIGTERM before it kills the agent. */
const DESKTOP_STOP_MS = 4_000;

function inertBackend(): BrowserBackend {
  return {
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as BrowserBackend;
}

function reply(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

/**
 * A model server that never answers the session under test — only its
 * request's signal ends the wait. Side calls on other ids answer at once.
 */
function silentModel() {
  const state = { target: "", entered: 0 };
  const llamaComplete = async (params: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<CompletionResult> => {
    if (params.sessionId !== state.target) return reply("ok");
    state.entered += 1;
    const signal = params.signal;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw signal?.reason ?? new DOMException("aborted", "AbortError");
  };
  return { state, llamaComplete };
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe("a scheduled task's run across a stop and a start", () => {
  let stateDir: string;
  let workingDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-task-life-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-task-life-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    delete process.env.ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS;
    delete process.env.ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED;
    delete process.env.ATOMIC_AGENT_TASKS_RUN_ON_CREATE;
    resetConfigCache();
  });

  async function boot(
    llamaComplete: (params: {
      sessionId: string;
      signal?: AbortSignal;
    }) => Promise<CompletionResult>,
  ): Promise<AgentRuntime> {
    return createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: inertBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete,
      },
    });
  }

  /** A table as the next process to open it would find it. */
  function readTasks<T>(read: (store: TaskStore) => T): T {
    const store = new TaskStore({ dbFile: join(stateDir, "tasks.sqlite") });
    try {
      return read(store);
    } finally {
      store.close();
    }
  }

  it("stops the scheduler's task turn at shutdown and rearms the recurring task", async () => {
    // The ticker picks the task up; nothing else runs it.
    process.env.ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS = "20";
    process.env.ATOMIC_AGENT_TASKS_RUN_ON_CREATE = "false";
    resetConfigCache();
    const model = silentModel();
    const runtime = await boot(model.llamaComplete);
    const session = runtime.createSession();
    model.state.target = session.id;
    const task = runtime.taskRunner.create({
      sessionId: session.id,
      userMessage: "hello",
      origin: "cli",
      maxAttempts: 3,
      schedule: { kind: "interval", everyMs: 5 * 60_000 },
      scheduledFor: Date.now() - 1,
    });
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    expect(runtime.taskStore.get(task.id)?.status).toBe("running");

    const started = Date.now();
    await runtime.shutdown();
    // The turn is stopped, not waited out: inside the 4 s the desktop
    // gives a stop before it kills the agent.
    expect(Date.now() - started).toBeLessThan(DESKTOP_STOP_MS);

    const after = readTasks((store) => store.get(task.id));
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(0);
    expect(after?.lastError).toBe(TASK_INTERRUPTED_ERROR);
    expect(after?.lastErrorCategory).toBe("cancelled");
    expect(after?.scheduledFor).toBeGreaterThan(started);
    expect(after?.sessionId).toBe(session.id);

    // The session's turn wrote its own end, not shutdown's stand-in.
    const sessions = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
    try {
      const stored = sessions.load(session.id);
      expect(stored?.status).toBe("cancelled");
      expect(stored?.lastError).not.toBe(INTERRUPTED_TURN_ENDING.lastError);
    } finally {
      sessions.close();
    }
  });

  it("stops a one-shot task's turn at shutdown and leaves it due for the next start", async () => {
    const model = silentModel();
    const runtime = await boot(model.llamaComplete);
    const session = runtime.createSession();
    model.state.target = session.id;
    // Run at once by the create's own drain (`tasks.runOnCreate`).
    const task = runtime.taskRunner.create({
      sessionId: session.id,
      userMessage: "once",
      origin: "cli",
      maxAttempts: 3,
    });
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);

    const started = Date.now();
    await runtime.shutdown();
    expect(Date.now() - started).toBeLessThan(DESKTOP_STOP_MS);

    const after = readTasks((store) => store.get(task.id));
    expect(after?.status).toBe("pending");
    expect(after?.scheduledFor).toBeNull();
    expect(after?.lastErrorCategory).toBe("cancelled");
    // Due now: the next start's first tick runs it.
    expect(
      readTasks((store) => store.listDue(Date.now()).map((t) => t.id)),
    ).toEqual([task.id]);
  });

  it("stops a running task's turn when the task is cancelled", async () => {
    const model = silentModel();
    const runtime = await boot(model.llamaComplete);
    try {
      const session = runtime.createSession();
      model.state.target = session.id;
      const task = runtime.taskRunner.create({
        sessionId: session.id,
        userMessage: "every 5m",
        origin: "cli",
        maxAttempts: 3,
        schedule: { kind: "interval", everyMs: 5 * 60_000 },
        scheduledFor: Date.now() - 1,
      });
      expect(await waitFor(() => model.state.entered === 1)).toBe(true);
      expect(runtime.taskRunner.cancel(task.id)?.status).toBe("cancelled");
      expect(
        await waitFor(
          () => runtime.sessionStore.load(session.id)?.status === "cancelled",
        ),
      ).toBe(true);
      expect(
        await waitFor(
          () => !runtime.turnController.busySessionIds().includes(session.id),
        ),
      ).toBe(true);
      // Cancelled for good: the recurring task is not rearmed.
      expect(runtime.taskStore.get(task.id)?.status).toBe("cancelled");
    } finally {
      await runtime.shutdown();
    }
  });

  it("takes back, at boot, a task whose agent is gone however recently it started, and leaves a live agent's", async () => {
    process.env.ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED = "false";
    resetConfigCache();
    const dbFile = join(stateDir, "tasks.sqlite");
    // A process that has exited; its pid is free.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const seedRunning = (pid: number): string => {
      const store = new TaskStore({
        dbFile,
        ownerProbe: {
          pid,
          host: hostIdentity(),
          hostUptime,
          isAlive: () => true,
          processStartOf: () => null,
        },
      });
      try {
        const task = store.create({
          sessionId: "s-elsewhere",
          userMessage: "hello every 5m",
          origin: "cli",
          maxAttempts: 3,
        });
        // Claimed a moment ago: far inside `tasks.staleAfterMs`.
        expect(store.markRunning(task.id)?.status).toBe("running");
        return task.id;
      } finally {
        // Closing is not ending the run: that process died mid-turn.
        store.close();
      }
    };
    const deadOwners = seedRunning(deadPid);
    // The process that started this test's runner: alive throughout.
    const liveOwners = seedRunning(process.ppid);

    const runtime = await boot(silentModel().llamaComplete);
    try {
      const taken = runtime.taskStore.get(deadOwners);
      expect(taken?.status).toBe("pending");
      expect(taken?.startedAt).toBeNull();
      expect(taken?.lastError).toBe(TASK_OWNER_GONE_ERROR);
      expect(runtime.taskStore.get(liveOwners)?.status).toBe("running");
    } finally {
      await runtime.shutdown();
    }
    // Shutting down does not touch a run another process owns.
    expect(readTasks((store) => store.get(liveOwners)?.status)).toBe(
      "running",
    );
  });
});
