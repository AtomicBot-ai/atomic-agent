import type { AtomicAgentConfig } from "../../config/index.js";
import { resolveWebhookSessionId } from "../../http/route-webhooks.js";
import type { WebhookSessionStore } from "../../http/webhook-session-store.js";
import { ImapMailTrigger, type ImapConnect } from "../../imap-mail/index.js";
import type { SchedulerSidecar } from "../../scheduler/index.js";
import type { TaskRunner } from "../../tasks/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentRuntime } from "../runtime-contract.js";

/**
 * The IMAP mail trigger (ATO-601) as a scheduler sidecar, or `null`
 * when no webhook binding declares `source: "imap"` (the default), so a
 * config without one never opens a mailbox. Tasks go in through
 * `TaskRunner.create` exactly like a webhook hit or an Atomic Mail one.
 */
export function createRuntimeImapTrigger(args: {
  config: Pick<AtomicAgentConfig, "webhooks" | "paths" | "tasks">;
  taskRunner: Pick<TaskRunner, "create">;
  createSession: AgentRuntime["createSession"];
  webhookSessionStore: WebhookSessionStore;
  logger: StructuredLogger;
  /** Test seam. */
  connect?: ImapConnect;
}): SchedulerSidecar | null {
  const { config, taskRunner, createSession, webhookSessionStore, logger } = args;
  const hasImapBinding = Object.values(config.webhooks).some((w) => w.source === "imap");
  if (!hasImapBinding || !config.tasks.enabled) return null;
  const trigger = new ImapMailTrigger({
    stateDir: config.paths.stateDir,
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
    logger,
    ...(args.connect ? { connect: args.connect } : {}),
  });
  return { tick: (now, signal) => trigger.tick(now, signal) };
}
