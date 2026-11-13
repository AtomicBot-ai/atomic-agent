import type { ToolDefinition, ToolRegistry } from "../tool-registry.js";
import type { TaskRunner, TaskStore } from "../../tasks/index.js";
import type { SessionState } from "../../session/index.js";

import { buildTasksScheduleTool } from "./tasks-schedule.js";
import { buildTasksCronTool } from "./tasks-cron.js";
import { buildTasksListTool } from "./tasks-list.js";
import { buildTasksCancelTool } from "./tasks-cancel.js";
import { buildTasksShowTool } from "./tasks-show.js";
import { INCOGNITO_TASK_REFUSAL, refuseInIncognito } from "../memory/incognito-guard.js";

export { buildTasksScheduleTool } from "./tasks-schedule.js";
export { buildTasksCronTool } from "./tasks-cron.js";
export { buildTasksListTool } from "./tasks-list.js";
export { buildTasksCancelTool } from "./tasks-cancel.js";
export { buildTasksShowTool } from "./tasks-show.js";

export interface RegisterTaskToolsOptions {
  taskStore: TaskStore;
  taskRunner: TaskRunner;
  /** Factory used by `tasks.schedule` when `newSession: true` is requested. */
  createSession(input?: { metadata?: Record<string, unknown> }): SessionState;
  /** Master kill switch — maps to `config.tasks.agentToolsEnabled`. */
  agentToolsEnabled: boolean;
  /**
   * Default `maxAttempts` applied when the agent omits the field.
   * Mirrors the HTTP / CLI defaults so self-scheduled work follows
   * the same retry curve as operator-created work.
   */
  defaultMaxAttempts: number;
  /** Default `limit` for `tasks.list`. */
  defaultListLimit: number;
  /**
   * ATO-586. `tasks.schedule` and `tasks.cron` refuse in an incognito
   * chat: always when the call says so (`ToolContext.incognito`), and
   * also when this answers true for the call's session. Listing, showing
   * and cancelling tasks stay allowed: they keep nothing from the chat.
   */
  isIncognitoSession?: (sessionId: string) => boolean;
}

/**
 * Register the five agent-side task tools. No-op when
 * `agentToolsEnabled` is false — the kill switch is honoured here
 * rather than in each tool so a disabled suite never appears in the
 * tool catalog (and thus never in the grammar-driven tool picker).
 */
export function registerTaskTools(
  registry: ToolRegistry,
  options: RegisterTaskToolsOptions,
): void {
  if (!options.agentToolsEnabled) return;
  const guarded = (tool: ToolDefinition): ToolDefinition =>
    refuseInIncognito(tool, options.isIncognitoSession, INCOGNITO_TASK_REFUSAL);
  registry.register(
    guarded(buildTasksScheduleTool({
      taskRunner: options.taskRunner,
      createSession: options.createSession,
      defaultMaxAttempts: options.defaultMaxAttempts,
    })),
  );
  registry.register(guarded(buildTasksCronTool({ taskRunner: options.taskRunner })));
  registry.register(
    buildTasksListTool({
      taskStore: options.taskStore,
      defaultLimit: options.defaultListLimit,
    }),
  );
  registry.register(buildTasksCancelTool({ taskStore: options.taskStore }));
  registry.register(buildTasksShowTool({ taskStore: options.taskStore }));
}
