import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { INCOGNITO_TASK_CREATE_REFUSAL, TasksOrchestrator } from "./tasks-orchestrator.js";

/**
 * ATO-586: `/task new` and the Tasks tab form create nothing from an
 * incognito chat, since the task would keep its prompt and run it later
 * in an ordinary chat. An ordinary chat creates tasks as before.
 */
function setup(incognito: boolean) {
  const create = vi.fn(() => ({ id: "t1" }));
  const emit = vi.fn();
  const runtime = { taskRunner: { create }, taskStore: { list: () => [] } } as unknown as AgentRuntime;
  const tasks = new TasksOrchestrator(runtime, { emit } as never, {
    getCurrentSessionId: () => "chat",
    switchSession: () => undefined,
    isCurrentSessionIncognito: () => incognito,
  });
  return { tasks, create, emit };
}

const input = { schedule: { kind: "cron", expression: "* * * * *" }, message: "remind me about X", kind: "cron" } as never;

describe("TasksOrchestrator.createTask in an incognito chat", () => {
  it("refuses without creating a task, and settles the form with the reason", () => {
    const { tasks, create, emit } = setup(true);
    tasks.createTask(input);
    expect(create).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: "tasks_create_submit_settled", error: INCOGNITO_TASK_CREATE_REFUSAL });
    expect(emit).toHaveBeenCalledWith({ type: "system_message", text: INCOGNITO_TASK_CREATE_REFUSAL });
  });

  it("creates the task in an ordinary chat", () => {
    const { tasks, create } = setup(false);
    tasks.createTask(input);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
