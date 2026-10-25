import { describe, it, expect, vi } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import type { SessionState } from "../../session/index.js";
import type { TaskCreateInput } from "../../tasks/index.js";

import { buildTasksScheduleTool } from "./tasks-schedule.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "current-session",
    stepIndex: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeTaskRunner() {
  const create = vi.fn((input: TaskCreateInput) => ({
    id: "task-42",
    sessionId: input.sessionId ?? "created-session",
    userMessage: input.userMessage,
    status: "pending" as const,
    origin: input.origin,
    triggerSource: input.triggerSource ?? null,
    attempts: 0,
    maxAttempts: input.maxAttempts,
    maxSteps: input.maxSteps ?? null,
    lastError: null,
    lastErrorCategory: null,
    schedule: input.schedule ?? null,
    scheduledFor: input.scheduledFor ?? null,
    recurring:
      input.schedule?.kind === "cron" || input.schedule?.kind === "interval",
    lastScheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    notify: input.notify ?? null,
  }));
  return { create };
}

function makeSessionFactory() {
  const create = vi.fn(
    (input?: { metadata?: Record<string, unknown> }): SessionState => ({
      id: "fresh-session",
      workingDir: "/work",
      status: "idle",
      knownFacts: [],
      latestResult: null,
      loadedSkills: [],
      worldSnapshot: null,
      stepCount: 0,
      turnCount: 0,
      turns: [],
      createdAt: 0,
      updatedAt: 0,
      lastError: null,
      metadata: input?.metadata ?? {},
    }),
  );
  return create;
}

describe("tasks.schedule", () => {
  it("inherits the current session by default", async () => {
    const runner = makeTaskRunner();
    const createSession = makeSessionFactory();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession,
      defaultMaxAttempts: 3,
    });
    const result = await tool.run(
      { userMessage: "ping me" },
      makeCtx({ sessionId: "caller" }),
    );
    expect(result.status).toBe("ok");
    expect(createSession).not.toHaveBeenCalled();
    expect(runner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "caller",
        userMessage: "ping me",
        origin: "agent",
        triggerSource: "agent",
      }),
    );
  });

  it("creates a fresh session when newSession=true", async () => {
    const runner = makeTaskRunner();
    const createSession = makeSessionFactory();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession,
      defaultMaxAttempts: 3,
    });
    const result = await tool.run(
      { userMessage: "ping me", newSession: true },
      makeCtx({ sessionId: "caller" }),
    );
    expect(result.status).toBe("ok");
    expect(createSession).toHaveBeenCalledOnce();
    expect(runner.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "fresh-session" }),
    );
  });

  it("translates inSeconds into an `at` schedule", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession: makeSessionFactory(),
      defaultMaxAttempts: 3,
    });
    const before = Date.now();
    const result = await tool.run(
      { userMessage: "later", inSeconds: 60 },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    const schedule = runner.create.mock.calls[0]![0].schedule;
    expect(schedule?.kind).toBe("at");
    if (schedule?.kind === "at") {
      expect(schedule.at).toBeGreaterThanOrEqual(before + 59_000);
    }
  });

  it("rejects empty userMessage", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession: makeSessionFactory(),
      defaultMaxAttempts: 3,
    });
    const result = await tool.run({ userMessage: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(runner.create).not.toHaveBeenCalled();
  });

  it("surfaces a validation error for conflicting at + inSeconds", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession: makeSessionFactory(),
      defaultMaxAttempts: 3,
    });
    const result = await tool.run(
      { userMessage: "x", at: Date.now() + 5_000, inSeconds: 5 },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("schedule");
    expect(runner.create).not.toHaveBeenCalled();
  });

  it("treats zero-valued and null schedule fields as not given (ATO-891)", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession: makeSessionFactory(),
      defaultMaxAttempts: 3,
    });
    const before = Date.now();
    const relative = await tool.run(
      { userMessage: "later", at: 0, inSeconds: 60 },
      makeCtx(),
    );
    expect(relative.status).toBe("ok");
    const first = runner.create.mock.calls[0]![0].schedule;
    expect(first?.kind === "at" && first.at).toBeGreaterThanOrEqual(before + 59_000);

    const target = Date.now() + 120_000;
    const absolute = await tool.run(
      { userMessage: "at a time", at: target, inSeconds: null },
      makeCtx(),
    );
    expect(absolute.status).toBe("ok");
    expect(runner.create.mock.calls[1]![0].schedule).toEqual({ kind: "at", at: target });

    const eager = await tool.run(
      { userMessage: "now", at: 0, inSeconds: 0 },
      makeCtx(),
    );
    expect(eager.status).toBe("ok");
    expect(runner.create.mock.calls[2]![0].schedule).toBeUndefined();

    const nonNumbers = await tool.run(
      { userMessage: "later", at: false, inSeconds: 60 },
      makeCtx(),
    );
    expect(nonNumbers.status).toBe("ok");
    expect(runner.create.mock.calls[3]![0].schedule?.kind).toBe("at");
    const stringZero = await tool.run(
      { userMessage: "later", at: "0", inSeconds: 60 },
      makeCtx(),
    );
    expect(stringZero.status).toBe("ok");
  });

  it('passes notify: "telegram" through to the created record', async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession: makeSessionFactory(),
      defaultMaxAttempts: 3,
    });
    const result = await tool.run(
      { userMessage: "remind me", inSeconds: 60, notify: "telegram" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(runner.create.mock.calls[0]![0].notify).toBe("telegram");
    expect(result.details.notify).toBe("telegram");
  });

  it("rejects an unknown notify target without creating anything", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksScheduleTool({
      taskRunner: runner as never,
      createSession: makeSessionFactory(),
      defaultMaxAttempts: 3,
    });
    const result = await tool.run(
      { userMessage: "x", notify: "email" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("notify");
    expect(runner.create).not.toHaveBeenCalled();
  });
});
