import { createSessionCompactionHandler } from "./route-compaction.js";
import { createRollbackLastTurnHandler } from "./route-rollback-last-turn.js";
import { createForkSessionHandler, createListRewindPointsHandler, createRewindHandler } from "./route-session-rewind.js";
import { createResumeInterruptedTurnHandler } from "./route-resume-interrupted-turn.js";
import type { RouteDefinition } from "./http-server.js";

import { createChatCompletionsHandler } from "./openai-chat-completions.js";
import {
  createAnthropicCountTokensHandler,
  createAnthropicMessagesHandler,
} from "./anthropic-messages.js";
import { createResponsesHandler } from "./openai-responses.js";
import { createAgUiRunHandler } from "./route-ag-ui.js";
import { createCancelCompletionHandler } from "./openai-completions-cancel.js";
import { createHealthHandler } from "./route-health.js";
import { createLocalModelRecheckHandler } from "./route-local-model-recheck.js";
import { createModelTiersHandler } from "./route-model-tiers.js";
import { createModelsHandler } from "./route-models.js";
import { createCapabilitiesHandler } from "./route-capabilities.js";
import {
  createGetConfigHandler,
  createPatchConfigHandler,
  createPutConfigHandler,
} from "./route-config.js";
import {
  createGetSkillHandler,
  createInstallSkillHandler,
  createListSkillsHandler,
  createUninstallSkillHandler,
} from "./route-skills.js";
import {
  createProjectTrustAnswerHandler,
  createProjectTrustStatusHandler,
} from "./route-project-trust.js";
import {
  createAckUndeliveredSteersHandler,
  createDeleteSessionHandler,
  createGetSessionHandler,
  createGetSessionNextStepHandler,
  createGetUndeliveredSteersHandler,
  createListSessionsHandler,
  createSearchSessionsHandler,
  createSteerSessionHandler,
} from "./route-sessions.js";
import { createRenameSessionHandler } from "./route-session-title.js";
import { createGetSessionGoalHandler, createSessionGoalActionHandler } from "./route-session-goal.js";
import { createExportSessionHandler } from "./route-session-export.js";
import { createSetSessionArchivedHandler } from "./route-session-archived.js";
import {
  createEscalateFusionWorkerHandler,
  createListFusionWorkersHandler,
  createSteerFusionWorkerHandler,
  createStopFusionWorkerHandler,
} from "./route-fusion-workers.js";
import {
  createApprovalEventsHandler,
  createResolveApprovalHandler,
} from "./route-approval.js";
import { createAnswerQuestionHandler } from "./route-question.js";
import {
  createDeleteApprovalRuleHandler,
  createListApprovalRulesHandler,
} from "./route-approval-rules.js";
import {
  createCancelTaskHandler,
  createCreateTaskHandler,
  createDrainTasksHandler,
  createGetTaskHandler,
  createListTasksHandler,
  createRunTaskHandler,
  createWakeTasksHandler,
} from "./route-tasks.js";
import {
  createListTaskRunsHandler,
  createPauseTaskHandler,
  createResumeTaskHandler,
} from "./route-task-controls.js";
import {
  createAcceptIdeaHandler,
  createDismissIdeaHandler,
  createListIdeasHandler,
  createRefreshIdeasHandler,
} from "./route-ideas.js";
import { createWebhookHandler } from "./route-webhooks.js";
import { createListWebhooksHandler } from "./route-webhooks-list.js";
import {
  createCreateWebhookHandler,
  createDeleteWebhookHandler,
} from "./route-webhooks-admin.js";
import { createCodingModeHandlers } from "./route-coding-mode.js";
import { createGetOfflineModeHandler, createSetOfflineModeHandler } from "./route-offline-mode.js";
import { createContextPreviewHandler } from "./route-context-preview.js";
import { createPlainCompleteHandler } from "./route-complete.js";
import {
  createRestartMcpServerHandler,
  createSetMcpServerEnabledHandler,
} from "./route-mcp.js";
import { createTelegramPairingHandlers } from "./route-telegram-pairing.js";
import { createSetActiveLlmHandler } from "./route-llm-active.js";
import { createLocalModelsTextHandler } from "./route-local-models.js";
import { createPanelPageHandler, createPanelScriptHandler } from "./route-panel.js";
import { createSetSessionWorkingDirHandler } from "./session-working-dir.js";
import { createRestoreFileHandler } from "./route-fs-restore.js";
import { createReconnectMemoryEmbeddingsHandler } from "./route-memory-embeddings.js";
import {
  createDeleteMemoryNoteHandler,
  createDeleteProfileFactHandler,
  createEditMemoryNoteHandler,
  createEditProfileFactHandler,
  createListMemoryNotesHandler,
  createListProfileFactsHandler,
  createProfileFactHistoryHandler,
} from "./route-memory.js";
import {
  createListMemoryChangesHandler,
  createRestoreMemoryChangeHandler,
  createRestoreProfileVersionHandler,
} from "./route-memory-history.js";
import { createTelegramChannelHandler } from "./route-telegram-channel.js";
import { createMetricsHandler } from "./route-metrics.js";
import type { PrometheusRegistry } from "../tracing/prometheus-registry.js";

export interface RouteTableOptions {
  /**
   * What the runtime counted since boot, for `GET /metrics` (ATO-646).
   * Without it the route still answers the readings it takes at scrape
   * time (turns running, tasks per status).
   */
  metricsRegistry?: PrometheusRegistry;
}

/**
 * Build the full atomic-agent HTTP route table. All handlers are
 * instantiated here so the serve command only needs to hand the
 * runtime to `createHttpServer`. Unauthenticated routes are the
 * minimum set an OpenAI SDK probes before attempting auth: `/health`
 * and `/v1/models`.
 */
export function buildRouteTable(options: RouteTableOptions = {}): RouteDefinition[] {
  // One closure for the GET and the POST: the coding mode is per-process
  // state, and the live switches cannot be read back as the mode that
  // set them (see route-coding-mode.ts `inferMode`).
  const codingMode = createCodingModeHandlers();
  // Same reason: the last pairing window's outcome is per-process state
  // the GET reads back after the POST opened it.
  const telegramPairing = createTelegramPairingHandlers();
  return [
    {
      method: "GET",
      path: "/health",
      handler: createHealthHandler(),
      requiresAuth: false,
    },
    {
      method: "GET",
      path: "/v1/models",
      handler: createModelsHandler(),
      requiresAuth: false,
    },
    // ATO-1128: the phone panel's page; it holds no data and asks for the key (route-panel.ts).
    { method: "GET", path: "/panel", handler: createPanelPageHandler(), requiresAuth: false },
    { method: "GET", path: "/panel/app.js", handler: createPanelScriptHandler(), requiresAuth: false },
    // ATO-646: Prometheus scrape target. Authenticated like every /api route.
    { method: "GET", path: "/metrics", handler: createMetricsHandler(options.metricsRegistry) },
    {
      method: "POST",
      path: "/v1/chat/completions",
      handler: createChatCompletionsHandler(),
    },
    {
      method: "POST",
      path: "/v1/chat/completions/{completion_id}/cancel",
      handler: createCancelCompletionHandler(),
    },
    // ATO-1080: Anthropic Messages and OpenAI Responses on the same turn path
    // (compat-bridge.ts), for Claude Code, Codex and the Agents SDK.
    { method: "POST", path: "/v1/messages", handler: createAnthropicMessagesHandler() },
    { method: "POST", path: "/v1/messages/count_tokens", handler: createAnthropicCountTokensHandler() },
    { method: "POST", path: "/v1/responses", handler: createResponsesHandler() },
    // ATO-694: the same turn as AG-UI events, for AG-UI web frontends (route-ag-ui.ts).
    { method: "POST", path: "/api/ag-ui", handler: createAgUiRunHandler() },
    {
      method: "GET",
      path: "/api/capabilities",
      handler: createCapabilitiesHandler(),
    },
    // ATO-32: the Cheap / Balanced / Best picks (presets/model-tiers.ts).
    { method: "GET", path: "/api/model-tiers", handler: createModelTiersHandler() },
    { method: "POST", path: "/api/sessions/{id}/compact", handler: createSessionCompactionHandler(true) },
    { method: "GET", path: "/api/sessions/{id}/compaction", handler: createSessionCompactionHandler(false) },
    { method: "GET", path: "/api/config", handler: createGetConfigHandler() },
    {
      method: "PATCH",
      path: "/api/config",
      handler: createPatchConfigHandler(),
    },
    // ATO-1022: the desktop's whole-file write, without an `atag config set` process.
    { method: "PUT", path: "/api/config", handler: createPutConfigHandler() },
    { method: "GET", path: "/api/skills", handler: createListSkillsHandler() },
    {
      method: "GET",
      path: "/api/skills/{name}",
      handler: createGetSkillHandler(),
    },
    {
      method: "POST",
      path: "/api/skills/install",
      handler: createInstallSkillHandler(),
    },
    {
      method: "POST",
      path: "/api/skills/uninstall",
      handler: createUninstallSkillHandler(),
    },
    { method: "GET", path: "/api/project-trust", handler: createProjectTrustStatusHandler() },
    { method: "POST", path: "/api/project-trust", handler: createProjectTrustAnswerHandler() },
    {
      method: "POST",
      path: "/api/mcp/servers/{name}/restart",
      handler: createRestartMcpServerHandler(),
    },
    {
      method: "POST",
      path: "/api/mcp/servers/{name}/enable",
      handler: createSetMcpServerEnabledHandler(true),
    },
    {
      method: "POST",
      path: "/api/mcp/servers/{name}/disable",
      handler: createSetMcpServerEnabledHandler(false),
    },
    {
      method: "GET",
      path: "/api/sessions",
      handler: createListSessionsHandler(),
    },
    // ATO-1149: full-text search over past chats. Before `{id}`, which
    // would otherwise take `search` for a session id.
    { method: "GET", path: "/api/sessions/search", handler: createSearchSessionsHandler() },
    {
      method: "GET",
      path: "/api/sessions/{id}",
      handler: createGetSessionHandler(),
    },
    {
      method: "DELETE",
      path: "/api/sessions/{id}",
      handler: createDeleteSessionHandler(),
    },
    {
      method: "PATCH",
      path: "/api/sessions/{id}",
      handler: createRenameSessionHandler(),
    },
    // ATO-1054: one chat as Markdown / HTML / DOCX (PDF is printed from the HTML by the client).
    { method: "GET", path: "/api/sessions/{id}/export", handler: createExportSessionHandler() },
    // ATO-731: one chat's folder, changed without restarting serve.
    { method: "POST", path: "/api/sessions/{id}/working-dir", handler: createSetSessionWorkingDirHandler() },
    // ATO-1040: the chat's goal, and the TUI's /goal set, pause, resume and clear.
    { method: "GET", path: "/api/sessions/{id}/goal", handler: createGetSessionGoalHandler() },
    { method: "POST", path: "/api/sessions/{id}/goal", handler: createSessionGoalActionHandler() },
    // ATO-1093: the suggested next message after the last finished turn.
    { method: "GET", path: "/api/sessions/{id}/next-step", handler: createGetSessionNextStepHandler() },
    // ATO-1150: archive or unarchive a chat (metadata.archived, seen by the desktop and the terminal).
    { method: "POST", path: "/api/sessions/{id}/archived", handler: createSetSessionArchivedHandler() },
    // ATO-1298: take the last plain question and answer back, for a real retry.
    { method: "POST", path: "/api/sessions/{id}/rollback-last-turn", handler: createRollbackLastTurnHandler() },
    // ATO-1056 / ATO-1058: roll a chat back to a question with its files, or fork it there.
    { method: "GET", path: "/api/sessions/{id}/rewind-points", handler: createListRewindPointsHandler() },
    { method: "POST", path: "/api/sessions/{id}/rewind/preview", handler: createRewindHandler(true) },
    { method: "POST", path: "/api/sessions/{id}/rewind", handler: createRewindHandler(false) },
    { method: "POST", path: "/api/sessions/{id}/fork", handler: createForkSessionHandler() },
    // ATO-563: put back a file the agent replaced, from its saved copy (the desktop's Revert).
    { method: "POST", path: "/api/sessions/{id}/fs/restore", handler: createRestoreFileHandler() },
    // ATO-448: continue a reply a restart cut off, on the person's click.
    { method: "POST", path: "/api/sessions/{id}/resume", handler: createResumeInterruptedTurnHandler() },
    {
      method: "POST",
      path: "/api/sessions/{id}/steer",
      handler: createSteerSessionHandler(),
    },
    {
      method: "GET",
      path: "/api/sessions/{id}/steer",
      handler: createGetUndeliveredSteersHandler(),
    },
    {
      method: "DELETE",
      path: "/api/sessions/{id}/steer",
      handler: createAckUndeliveredSteersHandler(),
    },
    // ATO-568: the person's stop / steer / escalate on one running fusion
    // worker of this session's fan-out (the desktop's subagent panel).
    { method: "GET", path: "/api/sessions/{id}/fusion/workers", handler: createListFusionWorkersHandler() },
    { method: "POST", path: "/api/sessions/{id}/fusion/workers/{taskId}/stop", handler: createStopFusionWorkerHandler() },
    { method: "POST", path: "/api/sessions/{id}/fusion/workers/{taskId}/steer", handler: createSteerFusionWorkerHandler() },
    { method: "POST", path: "/api/sessions/{id}/fusion/workers/{taskId}/escalate", handler: createEscalateFusionWorkerHandler() },
    {
      method: "POST",
      path: "/api/approval/resolve",
      handler: createResolveApprovalHandler(),
    },
    {
      method: "GET",
      path: "/api/events",
      handler: createApprovalEventsHandler(),
    },
    // ATO-489: the answer to an `ask_user` question shown from /api/events.
    { method: "POST", path: "/api/question/answer", handler: createAnswerQuestionHandler() },
    // ATO-1141: saved "always allow" / ask / deny rules.
    { method: "GET", path: "/api/approval-rules", handler: createListApprovalRulesHandler() },
    { method: "DELETE", path: "/api/approval-rules/{id}", handler: createDeleteApprovalRuleHandler() },
    // The two routes the desktop needs and the TUI does not: the coding-mode
    // stance it projects onto the approval ladder, and the context figure it
    // shows before the first message of a session.
    { method: "GET", path: "/api/coding-mode", handler: codingMode.get },
    { method: "POST", path: "/api/coding-mode", handler: codingMode.set },
    // ATO-1084: the network kill switch and its outbound counter.
    { method: "GET", path: "/api/offline-mode", handler: createGetOfflineModeHandler() },
    { method: "POST", path: "/api/offline-mode", handler: createSetOfflineModeHandler() },
    { method: "POST", path: "/api/context-preview", handler: createContextPreviewHandler() },
    // ATO-875: one plain model call, no tools, no session (route-complete.ts).
    { method: "POST", path: "/api/complete", handler: createPlainCompleteHandler() },
    // ATO-873: the desktop's Reconnect button after a local server answered 404/405.
    { method: "POST", path: "/api/local-model/recheck", handler: createLocalModelRecheckHandler() },
    // ATO-1021: the desktop's model pick, swapped live instead of restarting serve.
    { method: "POST", path: "/api/llm/active", handler: createSetActiveLlmHandler() },
    // ATO-1127: this machine's local models, for a desktop connected from another computer.
    { method: "GET", path: "/api/local-models/list", handler: createLocalModelsTextHandler("list") },
    { method: "GET", path: "/api/local-models/status", handler: createLocalModelsTextHandler("status") },
    // ATO-1213: and its embedding models, which the remote desktop listed as none.
    { method: "GET", path: "/api/local-models/list-embeddings", handler: createLocalModelsTextHandler("list-embeddings") },
    // ATO-1024: the desktop starts serve first and attaches the embedding server once it is up.
    { method: "POST", path: "/api/memory/embeddings/reconnect", handler: createReconnectMemoryEmbeddingsHandler() },
    // ATO-1124: the person's own list / edit / delete of notes and profile facts (route-memory.ts).
    { method: "GET", path: "/api/memory/notes", handler: createListMemoryNotesHandler() },
    { method: "PATCH", path: "/api/memory/notes/{id}", handler: createEditMemoryNoteHandler() },
    { method: "DELETE", path: "/api/memory/notes/{id}", handler: createDeleteMemoryNoteHandler() },
    { method: "GET", path: "/api/memory/profile", handler: createListProfileFactsHandler() },
    { method: "GET", path: "/api/memory/profile/{key}/history", handler: createProfileFactHistoryHandler() },
    { method: "PATCH", path: "/api/memory/profile/{key}", handler: createEditProfileFactHandler() },
    { method: "DELETE", path: "/api/memory/profile/{key}", handler: createDeleteProfileFactHandler() },
    // ATO-1059: what changed in memory, and the undo of one change (route-memory-history.ts).
    { method: "GET", path: "/api/memory/changes", handler: createListMemoryChangesHandler() },
    { method: "POST", path: "/api/memory/changes/{id}/restore", handler: createRestoreMemoryChangeHandler() },
    { method: "POST", path: "/api/memory/profile/{key}/restore", handler: createRestoreProfileVersionHandler() },
    // ATO-859: pairing the Telegram owner from the desktop; the code is in the POST's reply only.
    { method: "POST", path: "/api/telegram/pairing", handler: telegramPairing.start },
    { method: "GET", path: "/api/telegram/pairing", handler: telegramPairing.status },
    { method: "DELETE", path: "/api/telegram/pairing", handler: telegramPairing.cancel },
    // ATO-758: the channel's state, and another poller of the same bot when that is what holds it off.
    { method: "GET", path: "/api/telegram/channel", handler: createTelegramChannelHandler() },
    { method: "POST", path: "/api/tasks", handler: createCreateTaskHandler() },
    { method: "GET", path: "/api/tasks", handler: createListTasksHandler() },
    { method: "GET", path: "/api/tasks/{id}", handler: createGetTaskHandler() },
    {
      method: "DELETE",
      path: "/api/tasks/{id}",
      handler: createCancelTaskHandler(),
    },
    {
      method: "POST",
      path: "/api/tasks/{id}/run",
      handler: createRunTaskHandler(),
    },
    // ATO-590: the desktop's schedule controls (pause, resume, run history).
    { method: "POST", path: "/api/tasks/{id}/pause", handler: createPauseTaskHandler() },
    { method: "POST", path: "/api/tasks/{id}/resume", handler: createResumeTaskHandler() },
    { method: "GET", path: "/api/tasks/{id}/runs", handler: createListTaskRunsHandler() },
    {
      method: "POST",
      path: "/api/tasks/drain",
      handler: createDrainTasksHandler(),
    },
    // ATO-458: suggestions built from local tasks and goals; accept files a task.
    { method: "GET", path: "/api/ideas", handler: createListIdeasHandler() },
    { method: "POST", path: "/api/ideas/refresh", handler: createRefreshIdeasHandler() },
    { method: "POST", path: "/api/ideas/{id}/accept", handler: createAcceptIdeaHandler() },
    { method: "POST", path: "/api/ideas/{id}/dismiss", handler: createDismissIdeaHandler() },
    {
      method: "GET",
      path: "/api/webhooks",
      handler: createListWebhooksHandler(),
    },
    // ATO-592: the desktop's powerMonitor "resume" runs due tasks now.
    { method: "POST", path: "/api/tasks/wake", handler: createWakeTasksHandler() },
    {
      method: "POST",
      path: "/api/webhooks/{name}",
      handler: createWebhookHandler(),
    },
    // ATO-445: the desktop's Webhooks screen adds and removes routes.
    { method: "POST", path: "/api/webhooks", handler: createCreateWebhookHandler() },
    { method: "DELETE", path: "/api/webhooks/{name}", handler: createDeleteWebhookHandler() },
  ];
}
