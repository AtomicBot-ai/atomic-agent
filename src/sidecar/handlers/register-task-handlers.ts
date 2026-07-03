import {
  RuntimeApiError,
  cancelTask,
  createTask,
  drainTasks,
  getTask,
  listTasks,
  runTask,
  type TaskServiceDeps,
} from "../../runtime-api/index.js";
import type {
  TaskCancelPayload,
  TaskCancelResult,
  TaskCreatePayload,
  TaskCreateResult,
  TaskDrainPayload,
  TaskDrainResult,
  TaskGetPayload,
  TaskGetResult,
  TaskListPayload,
  TaskListResult,
  TaskRunPayload,
  TaskRunResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `task.*` — durable deferred-turn queue. Backs onto the shared task-service
 * facade; every write emits a best-effort `task.updated` event so a host
 * watching the stream sees the transition it triggered.
 */
export function registerTaskHandlers(ctx: SidecarHandlerContext): void {
  const { router, protocol, runtime } = ctx;

  const taskDeps: TaskServiceDeps = {
    config: {
      tasks: {
        enabled: runtime.config.tasks.enabled,
        maxAttempts: runtime.config.tasks.maxAttempts,
      },
    },
    taskRunner: runtime.taskRunner,
    taskStore: runtime.taskStore,
  };

  router.register<TaskCreatePayload, TaskCreateResult>(
    "task.create",
    (request) => {
      const task = createTask(taskDeps, {
        ...request.payload,
        origin: "sidecar",
      });
      protocol.emitEvent("task.updated", { task });
      return { task };
    },
  );

  router.register<TaskListPayload, TaskListResult>("task.list", (request) => ({
    tasks: listTasks(taskDeps, request.payload),
  }));

  router.register<TaskGetPayload, TaskGetResult>("task.get", (request) => {
    try {
      return { task: getTask(taskDeps, request.payload.taskId) };
    } catch (err) {
      if (err instanceof RuntimeApiError && err.code === "not_found") {
        return { task: null };
      }
      throw err;
    }
  });

  router.register<TaskCancelPayload, TaskCancelResult>(
    "task.cancel",
    (request) => {
      const task = cancelTask(taskDeps, request.payload.taskId);
      protocol.emitEvent("task.updated", { task });
      return { task };
    },
  );

  router.register<TaskRunPayload, TaskRunResult>("task.run", async (request) => {
    const task = await runTask(taskDeps, request.payload.taskId);
    if (task) protocol.emitEvent("task.updated", { task });
    return { task };
  });

  router.register<TaskDrainPayload, TaskDrainResult>(
    "task.drain",
    async (request) => ({
      outcome: await drainTasks(taskDeps, request.payload),
    }),
  );
}
