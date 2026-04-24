import type { RouteDefinition } from "./http-server.js";

import { createChatCompletionsHandler } from "./openai-chat-completions.js";
import { createCancelCompletionHandler } from "./openai-completions-cancel.js";
import { createHealthHandler } from "./route-health.js";
import { createModelsHandler } from "./route-models.js";
import { createCapabilitiesHandler } from "./route-capabilities.js";
import {
  createGetConfigHandler,
  createPatchConfigHandler,
} from "./route-config.js";
import {
  createGetSkillHandler,
  createInstallSkillHandler,
  createListSkillsHandler,
  createUninstallSkillHandler,
} from "./route-skills.js";
import {
  createDeleteSessionHandler,
  createGetSessionHandler,
  createListSessionsHandler,
} from "./route-sessions.js";
import {
  createApprovalEventsHandler,
  createResolveApprovalHandler,
} from "./route-approval.js";
import {
  createCancelTaskHandler,
  createCreateTaskHandler,
  createDrainTasksHandler,
  createGetTaskHandler,
  createListTasksHandler,
  createRunTaskHandler,
} from "./route-tasks.js";
import { createWebhookHandler } from "./route-webhooks.js";

/**
 * Build the full atomic-agent HTTP route table. All handlers are
 * instantiated here so the serve command only needs to hand the
 * runtime to `createHttpServer`. Unauthenticated routes are the
 * minimum set an OpenAI SDK probes before attempting auth: `/health`
 * and `/v1/models`.
 */
export function buildRouteTable(): RouteDefinition[] {
  return [
    { method: "GET", path: "/health", handler: createHealthHandler(), requiresAuth: false },
    { method: "GET", path: "/v1/models", handler: createModelsHandler(), requiresAuth: false },
    { method: "POST", path: "/v1/chat/completions", handler: createChatCompletionsHandler() },
    {
      method: "POST",
      path: "/v1/chat/completions/{completion_id}/cancel",
      handler: createCancelCompletionHandler(),
    },
    { method: "GET", path: "/api/capabilities", handler: createCapabilitiesHandler() },
    { method: "GET", path: "/api/config", handler: createGetConfigHandler() },
    { method: "PATCH", path: "/api/config", handler: createPatchConfigHandler() },
    { method: "GET", path: "/api/skills", handler: createListSkillsHandler() },
    { method: "GET", path: "/api/skills/{name}", handler: createGetSkillHandler() },
    { method: "POST", path: "/api/skills/install", handler: createInstallSkillHandler() },
    { method: "POST", path: "/api/skills/uninstall", handler: createUninstallSkillHandler() },
    { method: "GET", path: "/api/sessions", handler: createListSessionsHandler() },
    { method: "GET", path: "/api/sessions/{id}", handler: createGetSessionHandler() },
    { method: "DELETE", path: "/api/sessions/{id}", handler: createDeleteSessionHandler() },
    { method: "POST", path: "/api/approval/resolve", handler: createResolveApprovalHandler() },
    { method: "GET", path: "/api/events", handler: createApprovalEventsHandler() },
    { method: "POST", path: "/api/tasks", handler: createCreateTaskHandler() },
    { method: "GET", path: "/api/tasks", handler: createListTasksHandler() },
    { method: "GET", path: "/api/tasks/{id}", handler: createGetTaskHandler() },
    { method: "DELETE", path: "/api/tasks/{id}", handler: createCancelTaskHandler() },
    { method: "POST", path: "/api/tasks/{id}/run", handler: createRunTaskHandler() },
    { method: "POST", path: "/api/tasks/drain", handler: createDrainTasksHandler() },
    { method: "POST", path: "/api/webhooks/{name}", handler: createWebhookHandler() },
  ];
}
