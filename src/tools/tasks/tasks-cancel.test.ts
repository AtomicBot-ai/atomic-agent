import { describe, it, expect, vi } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import type { TaskRecord } from "../../tasks/index.js";

import { buildTasksCancelTool } from "./tasks-cancel.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "caller",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function makeRecord(): TaskRecord {
  return {
    id: "t1",
    sessionId: "caller",
    userMessage: "x",
    status: "cancelled",
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
    notify: null,
  };
}

describe("tasks.cancel", () => {
  it("cancels a known task", async () => {
    const cancel = vi.fn(() => makeRecord());
    const tool = buildTasksCancelTool({ taskStore: { cancel } as never });
    const result = await tool.run({ id: "t1" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(cancel).toHaveBeenCalledWith("t1");
  });

  it("returns error for unknown id", async () => {
    const cancel = vi.fn(() => null);
    const tool = buildTasksCancelTool({ taskStore: { cancel } as never });
    const result = await tool.run({ id: "missing" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.notFound).toBe(true);
  });

  it("rejects empty id", async () => {
    const cancel = vi.fn(() => null);
    const tool = buildTasksCancelTool({ taskStore: { cancel } as never });
    const result = await tool.run({ id: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(cancel).not.toHaveBeenCalled();
  });
});
