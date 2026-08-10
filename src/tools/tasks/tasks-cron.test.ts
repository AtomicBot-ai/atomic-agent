import { describe, it, expect, vi } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import type { TaskCreateInput } from "../../tasks/index.js";

import { buildTasksCronTool } from "./tasks-cron.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "caller",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function makeTaskRunner() {
  const create = vi.fn((input: TaskCreateInput) => ({
    id: "task-cron",
    sessionId: "recurring-session",
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
    recurring: true,
    lastScheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    notify: input.notify ?? null,
  }));
  return { create };
}

describe("tasks.cron", () => {
  it("creates a recurring cron task (caller session is NOT inherited)", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksCronTool({ taskRunner: runner as never });
    const result = await tool.run(
      { userMessage: "morning digest", expression: "0 9 * * *", tz: "Europe/Berlin" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    const input = runner.create.mock.calls[0]![0];
    expect(input.sessionId).toBeUndefined();
    expect(input.schedule).toEqual({
      kind: "cron",
      expression: "0 9 * * *",
      tz: "Europe/Berlin",
    });
    expect(input.origin).toBe("agent");
    expect(input.triggerSource).toBe("agent");
  });

  it("rejects a missing expression", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksCronTool({ taskRunner: runner as never });
    const result = await tool.run(
      { userMessage: "x", expression: "" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(runner.create).not.toHaveBeenCalled();
  });

  it("rejects non-string tz", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksCronTool({ taskRunner: runner as never });
    const result = await tool.run(
      { userMessage: "x", expression: "* * * * *", tz: 42 },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("tz");
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('passes notify: "telegram" through to the created record', async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksCronTool({ taskRunner: runner as never });
    const result = await tool.run(
      { userMessage: "digest", expression: "0 9 * * *", notify: "telegram" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(runner.create.mock.calls[0]![0].notify).toBe("telegram");
    expect(result.details.notify).toBe("telegram");
  });

  it("omits notify by default (task stays silent)", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksCronTool({ taskRunner: runner as never });
    const result = await tool.run(
      { userMessage: "digest", expression: "0 9 * * *" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(runner.create.mock.calls[0]![0].notify).toBeUndefined();
  });

  it("rejects an unknown notify target without creating anything", async () => {
    const runner = makeTaskRunner();
    const tool = buildTasksCronTool({ taskRunner: runner as never });
    const result = await tool.run(
      { userMessage: "x", expression: "* * * * *", notify: "slack" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("notify");
    expect(runner.create).not.toHaveBeenCalled();
  });
});
