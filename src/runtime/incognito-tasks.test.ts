import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import type { TurnOwnerProbe } from "../session/turn-owner.js";
import { TaskRunner, TaskStore } from "../tasks/index.js";
import { ToolRegistry, type ToolContext } from "../tools/tool-registry.js";
import { registerTaskTools } from "../tools/tasks/index.js";
import { INCOGNITO_TASK_REFUSAL } from "../tools/memory/incognito-guard.js";
import { StructuredLogger } from "../tracing/structured-logger.js";
import { createIncognitoSessions } from "./incognito-sessions.js";

/**
 * ATO-586: an incognito chat cannot leave tasks behind. `tasks.cron` and
 * `tasks.schedule` refuse in it, and closing it drops any task bound to
 * it, so no prompt from it stays in tasks.sqlite or runs later in an
 * ordinary, listed chat.
 */

function probe(): TurnOwnerProbe {
  return { pid: 1, host: "darwin", hostUptime: () => 50_000, isAlive: (p) => p === 1, processStartOf: () => null };
}

describe("incognito chats and tasks", () => {
  let dir: string;
  let sessionStore: SessionStore;
  let taskStore: TaskStore;
  let registry: ToolRegistry;
  const logger = new StructuredLogger({ level: "error", sinks: [] });

  const createSession = (input?: { metadata?: Record<string, unknown> }): SessionState => {
    const state = createEmptySessionState({ id: randomUUID(), workingDir: "/w", ...(input?.metadata ? { metadata: input.metadata } : {}) });
    sessionStore.save(state);
    return state;
  };
  const openChat = (incognito: boolean): string => {
    const id = randomUUID();
    sessionStore.save(recordTurn(
      createEmptySessionState({ id, workingDir: "/w", ...(incognito ? { incognito: sessionStore.newIncognitoMark() } : {}) }),
      userTurn("hi"),
    ));
    return id;
  };
  const ctx = (sessionId: string, extra: Partial<ToolContext> = {}): ToolContext => ({
    workingDir: "/w",
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "incognito-tasks-"));
    sessionStore = new SessionStore({ dbFile: join(dir, "sessions.sqlite"), turnOwnerProbe: probe() });
    taskStore = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
    const taskRunner = new TaskRunner({
      store: taskStore,
      runtime: { runTurn: vi.fn() } as never,
      sessionLoader: sessionStore,
      sessionFactory: { create: (input) => createSession(input), save: (state) => sessionStore.save(state) },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    registry = new ToolRegistry();
    registerTaskTools(registry, {
      taskStore,
      taskRunner,
      createSession,
      agentToolsEnabled: true,
      defaultMaxAttempts: 1,
      defaultListLimit: 20,
      isIncognitoSession: (id) => sessionStore.isIncognito(id),
    });
  });

  afterEach(() => {
    taskStore.close();
    sessionStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tasks.cron in an incognito chat leaves no task and no new chat after discard", async () => {
    const chat = openChat(true);
    const result = await registry.get("tasks.cron").run(
      { userMessage: "remind me about X", expression: "* * * * *" },
      ctx(chat, { incognito: true }),
    );
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("incognito_session");
    expect(result.summary).toContain(INCOGNITO_TASK_REFUSAL);

    const outcome = createIncognitoSessions({
      sessionStore, tracesDir: null, isBusy: () => false, logger, taskStore,
    }).discard(chat);
    expect(outcome).toBe("deleted");
    expect(taskStore.list().filter((t) => t.userMessage === "remind me about X")).toEqual([]);
    // No session was provisioned for a recurring task, and the chat itself is gone.
    expect(sessionStore.listRecent()).toEqual([]);
    expect(sessionStore.load(chat)).toBeNull();
  });

  it("tasks.schedule refuses when only the store knows the chat is incognito", async () => {
    const chat = openChat(true);
    const result = await registry.get("tasks.schedule").run({ userMessage: "later X" }, ctx(chat));
    expect(result.details.reason).toBe("incognito_session");
    expect(taskStore.list()).toEqual([]);
  });

  it("discard deletes a task bound to the chat that came in another way", () => {
    const chat = openChat(true);
    // E.g. filed over HTTP against the chat's id.
    taskStore.create({ sessionId: chat, userMessage: "secret follow-up", origin: "http", maxAttempts: 1 });
    expect(taskStore.list({ sessionId: chat })).toHaveLength(1);
    createIncognitoSessions({ sessionStore, tracesDir: null, isBusy: () => false, logger, taskStore }).discard(chat);
    expect(taskStore.list().filter((t) => t.userMessage === "secret follow-up")).toEqual([]);
  });

  it("an ordinary chat still schedules, and its tasks survive a discard attempt", async () => {
    const chat = openChat(false);
    const result = await registry.get("tasks.cron").run(
      { userMessage: "daily digest", expression: "0 9 * * *" },
      ctx(chat),
    );
    expect(result.status).toBe("ok");
    expect(createIncognitoSessions({ sessionStore, tracesDir: null, isBusy: () => false, logger, taskStore }).discard(chat)).toBe("not_incognito");
    expect(taskStore.list().map((t) => t.userMessage)).toEqual(["daily digest"]);
  });
});
