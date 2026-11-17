import { AtomicMailService, AtomicMailTrigger } from "../../atomic-mail/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { resolveWebhookSessionId } from "../../http/route-webhooks.js";
import type { WebhookSessionStore } from "../../http/webhook-session-store.js";
import { previousReplyText } from "../../prompt/request-section.js";
import type { SchedulerSidecar } from "../../scheduler/index.js";
import type { SessionStore } from "../../session/index.js";
import type { TaskRunner, TaskStore } from "../../tasks/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentRuntime } from "../runtime-contract.js";

/**
 * The mail trigger (ATO-601) as a scheduler sidecar, or `null` when no
 * webhook binding declares `source: "atomic-mail"` — the default, so a
 * config without one never reads the inbox. Tasks go in through
 * `TaskRunner.create` exactly like a webhook hit.
 */
export function createRuntimeMailTrigger(args: {
  config: Pick<AtomicAgentConfig, "webhooks" | "paths" | "tasks">;
  taskRunner: Pick<TaskRunner, "create">;
  taskStore: Pick<TaskStore, "get">;
  sessionStore: Pick<SessionStore, "load">;
  createSession: AgentRuntime["createSession"];
  webhookSessionStore: WebhookSessionStore;
  logger: StructuredLogger;
  /** Test seam. */
  mail?: ConstructorParameters<typeof AtomicMailTrigger>[0]["mail"];
}): SchedulerSidecar | null {
  const { config, taskRunner, taskStore, sessionStore, createSession, webhookSessionStore, logger } = args;
  const hasMailBinding = Object.values(config.webhooks).some((w) => w.source === "atomic-mail");
  if (!hasMailBinding || !config.tasks.enabled) return null;
  const trigger = new AtomicMailTrigger({
    stateDir: config.paths.stateDir,
    mail: args.mail ?? new AtomicMailService(),
    bindings: () => config.webhooks,
    createTask: ({ userMessage, sessionId }) =>
      taskRunner.create({
        ...(sessionId ? { sessionId } : {}),
        userMessage,
        origin: "scheduler",
        triggerSource: "webhook",
        maxAttempts: config.tasks.maxAttempts,
        maxSteps: null,
      }),
    resolveSessionId: (name, cfg) =>
      resolveWebhookSessionId(cfg, name, { createSession, webhookSessionStore }),
    getTask: (id) => taskStore.get(id),
    readReplyText: (sessionId) => {
      const session = sessionStore.load(sessionId);
      return session ? (previousReplyText(session.turns) ?? null) : null;
    },
    logger,
  });
  return { tick: (now, signal) => trigger.tick(now, signal) };
}
