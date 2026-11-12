import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { SessionState, SessionStore } from "../../session/index.js";
import type { TaskRunner, TaskStore } from "../../tasks/index.js";
import type { ToolRegistry } from "../tool-registry.js";

import { buildSessionsListTool } from "./sessions-list.js";
import { buildSessionsReadTool } from "./sessions-read.js";
import { buildSessionsSendTool } from "./sessions-send.js";
import { buildSessionsCheckTool } from "./sessions-check.js";

export { buildSessionsListTool } from "./sessions-list.js";
export { buildSessionsReadTool } from "./sessions-read.js";
export { buildSessionsSendTool } from "./sessions-send.js";
export { buildSessionsCheckTool, replyTo } from "./sessions-check.js";
export {
  crossSessionSender,
  frameCrossSessionMessage,
} from "./session-access.js";

/** The four names, in registration order (`filter-disabled-tools.ts` mirrors it). */
export const SESSION_TOOL_NAMES = [
  "sessions.list",
  "sessions.read",
  "sessions.send",
  "sessions.check",
] as const;

export interface RegisterSessionToolsOptions extends DangerousToolOptions {
  sessionStore: Pick<SessionStore, "listSummaryPage" | "listChatLines" | "load">;
  taskStore: Pick<TaskStore, "get">;
  taskRunner: Pick<TaskRunner, "create">;
  createSession(input?: { metadata?: Record<string, unknown> }): SessionState;
  defaultMaxAttempts: number;
  /**
   * `tasks.sessionToolsEnabled` (env `ATOMIC_AGENT_SESSION_TOOLS_ENABLED`,
   * default off) and `tasks.enabled`: a send is a queued task, so without
   * the task queue there is nothing to deliver it.
   */
  enabled: boolean;
}

/**
 * Register the cross-chat tools (ATO-570). No-op when off, so a disabled
 * suite is in neither the catalog nor the grammar-driven picker.
 */
export function registerSessionTools(
  registry: ToolRegistry,
  options: RegisterSessionToolsOptions,
): void {
  if (!options.enabled) return;
  const dangerous = {
    approvals: options.approvals,
    approvalRequired: options.approvalRequired,
  };
  registry.register(buildSessionsListTool({ sessionStore: options.sessionStore }));
  registry.register(
    buildSessionsReadTool({ ...dangerous, sessionStore: options.sessionStore }),
  );
  registry.register(
    buildSessionsSendTool({
      ...dangerous,
      sessionStore: options.sessionStore,
      taskRunner: options.taskRunner,
      createSession: options.createSession,
      defaultMaxAttempts: options.defaultMaxAttempts,
    }),
  );
  registry.register(
    buildSessionsCheckTool({
      taskStore: options.taskStore,
      sessionStore: options.sessionStore,
    }),
  );
}
