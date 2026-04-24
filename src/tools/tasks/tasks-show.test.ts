import { describe, it, expect, vi } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import type { TaskRecord } from "../../tasks/index.js";

import { buildTasksShowTool } from "./tasks-show.js";

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
    userMessage: "do a thing",
    status: "pending",
    origin: "agent",
    triggerSource: "agent",
    attempts: 0,
    maxAttempts: 3,
    maxSteps: null,
    lastError: null,
    lastErrorCategory: null,
    schedule: { kind: "at", at: 42 },
    scheduledFor: 42,
    recurring: false,
    lastScheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
  };
}

describe("tasks.show", () => {
  it("returns the full record for a known id", async () => {
    const get = vi.fn(() => makeRecord());
    const tool = buildTasksShowTool({ taskStore: { get } as never });
    const result = await tool.run({ id: "t1" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.schedule).toEqual({ kind: "at", at: 42 });
    expect(result.details.triggerSource).toBe("agent");
  });

  it("errors on unknown id", async () => {
    const get = vi.fn(() => null);
    const tool = buildTasksShowTool({ taskStore: { get } as never });
    const result = await tool.run({ id: "nope" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.notFound).toBe(true);
  });

  it("rejects missing id", async () => {
    const get = vi.fn(() => null);
    const tool = buildTasksShowTool({ taskStore: { get } as never });
    const result = await tool.run({}, makeCtx());
    expect(result.status).toBe("error");
    expect(get).not.toHaveBeenCalled();
  });
});
