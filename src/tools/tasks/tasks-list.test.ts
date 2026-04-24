import { describe, it, expect, vi } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import type { TaskRecord } from "../../tasks/index.js";

import { buildTasksListTool } from "./tasks-list.js";

function makeCtx(sessionId = "caller"): ToolContext {
  return {
    workingDir: "/work",
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    sessionId: "caller",
    userMessage: "do thing",
    status: "pending",
    origin: "agent",
    triggerSource: null,
    attempts: 0,
    maxAttempts: 3,
    maxSteps: null,
    lastError: null,
    lastErrorCategory: null,
    schedule: null,
    scheduledFor: null,
    recurring: false,
    lastScheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("tasks.list", () => {
  it("lists tasks for the current session by default", async () => {
    const list = vi.fn(() => [makeRecord({ id: "t1" }), makeRecord({ id: "t2" })]);
    const tool = buildTasksListTool({
      taskStore: { list } as never,
      defaultLimit: 20,
    });
    const result = await tool.run({}, makeCtx("caller"));
    expect(result.status).toBe("ok");
    expect(list).toHaveBeenCalledWith({ sessionId: "caller", limit: 20 });
    expect(result.details.count).toBe(2);
  });

  it("filters by a comma-separated status list", async () => {
    const list = vi.fn(() => []);
    const tool = buildTasksListTool({
      taskStore: { list } as never,
      defaultLimit: 20,
    });
    const result = await tool.run(
      { status: "pending,running" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["pending", "running"] }),
    );
  });

  it("rejects an invalid status value", async () => {
    const list = vi.fn(() => []);
    const tool = buildTasksListTool({
      taskStore: { list } as never,
      defaultLimit: 20,
    });
    const result = await tool.run({ status: "nope" }, makeCtx());
    expect(result.status).toBe("error");
    expect(list).not.toHaveBeenCalled();
  });

  it("caps limit at 200", async () => {
    const list = vi.fn(() => []);
    const tool = buildTasksListTool({
      taskStore: { list } as never,
      defaultLimit: 20,
    });
    await tool.run({ limit: 10_000 }, makeCtx());
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });
});
