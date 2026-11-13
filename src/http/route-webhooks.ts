import type { ServerResponse } from "node:http";

import { openaiError } from "./openai-errors.js";
import {
  parseJsonBody,
  readRawBody,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";
import { WebhookReplayCache } from "./webhook-replay-cache.js";
import { renderWebhookTemplate } from "./webhook-template.js";
import {
  checkSharedSecret,
  describeWebhookEvent,
  verifySignedWebhook,
  webhookEventAllowed,
} from "./webhook-verify.js";
import type { WebhookConfig } from "../config/index.js";
import { TaskValidationError } from "../tasks/index.js";

/**
 * `POST /api/webhooks/:name` — generic inbound webhook route. Resolves
 * the named binding from `config.webhooks`, authenticates it by the
 * binding's `verify` scheme (in addition to the global API key): the
 * optional `x-webhook-secret` header by default, or a GitHub /
 * Standard Webhooks HMAC signature over the raw body (ATO-438), renders
 * `userMessageTemplate` against the JSON body, and
 * materialises the result as a task via `TaskRunner.create`. The
 * handler NEVER calls `runTurn` directly — that invariant is what
 * keeps per-session FIFO intact under external triggers.
 *
 * Session resolution mirrors the docs in `config-schema.ts`:
 *  - `ephemeral`  -> no sessionId, runner creates one lazily per task
 *  - `persistent` -> reuse sessionId from `webhook-sessions.json`;
 *    first hit creates + persists a fresh session
 *  - `named`      -> use the configured sessionId verbatim
 *
 * Responses:
 *  - 202 `{ taskId }` on success
 *  - 200 `{ taskId: null, ignored | duplicate }` for a genuine hit that
 *    starts nothing (filtered event, GitHub `ping`, repeated `webhook-id`)
 *  - 404 when the webhook name is unknown or `tasks.enabled` is false
 *  - 401 on bad/missing secret header (only when the config declares one;
 *    compared in constant time, see `secretEquals`), or on a missing,
 *    wrong or stale signature for the signed schemes
 *  - 400 on invalid JSON body, unknown template fields, or schedule validation
 */
export function createWebhookHandler(
  options: { replayCache?: WebhookReplayCache; now?: () => number } = {},
): HttpHandler {
  const replayCache = options.replayCache ?? new WebhookReplayCache();
  const now = options.now ?? Date.now;
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: ctx.params.name ?? "<unknown>",
        status: "rejected",
      });
      return;
    }
    const name = ctx.params.name;
    if (!name) {
      sendError(res, 400, openaiError("webhook name is required"));
      return;
    }
    const webhook = ctx.runtime.config.webhooks[name];
    if (!webhook) {
      sendError(res, 404, openaiError(`webhook not found: ${name}`));
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: name,
        status: "rejected",
      });
      return;
    }
    const reject = (status: number, message: string): void => {
      sendError(res, status, openaiError(message, "invalid_request_error"));
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: name,
        status: "rejected",
      });
    };
    const signed = webhook.verify === "github" || webhook.verify === "standard-webhooks";
    if (!signed && !checkSharedSecret(webhook, req)) {
      reject(401, "invalid webhook secret");
      return;
    }
    let body: unknown = {};
    let replayKey: string | null = null;
    try {
      const raw = await readRawBody(req);
      if (signed) {
        const auth = verifySignedWebhook(webhook, req, raw, now());
        if (!auth.ok) {
          reject(401, `invalid webhook signature: ${auth.reason}`);
          return;
        }
        if (auth.messageId) replayKey = `${name}\n${auth.messageId}`;
      }
      body = parseJsonBody<unknown>(raw);
    } catch (err) {
      reject(400, err instanceof Error ? err.message : "invalid body");
      return;
    }
    const hit = describeWebhookEvent(webhook, req, body);
    if (replayKey && replayCache.has(replayKey)) {
      ignore(res, ctx, name, { duplicate: true, delivery: hit.delivery });
      return;
    }
    /* GitHub sends `ping` when a hook is created; it is not work to do. */
    if (
      (webhook.verify === "github" && hit.event === "ping") ||
      !webhookEventAllowed(webhook.events, hit)
    ) {
      ignore(res, ctx, name, { ignored: true, event: hit.event, action: hit.action });
      return;
    }
    const userMessage = renderWebhookTemplate(webhook.userMessageTemplate, body, {
      event: hit.event,
      action: hit.action,
      delivery: hit.delivery,
    });
    const sessionId = resolveWebhookSessionId(webhook, name, ctx.runtime);
    try {
      const created = ctx.runtime.taskRunner.create({
        ...(sessionId ? { sessionId } : {}),
        userMessage,
        origin: "http",
        triggerSource: "webhook",
        maxAttempts: ctx.runtime.config.tasks.maxAttempts,
        maxSteps: null,
        ...(webhook.schedule ? { schedule: webhook.schedule } : {}),
      });
      if (replayKey) replayCache.remember(replayKey);
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: name,
        status: "accepted",
      });
      sendJson(res, 202, { taskId: created.id, sessionId: created.sessionId });
    } catch (err) {
      if (err instanceof TaskValidationError) {
        sendError(
          res,
          400,
          openaiError(err.message, "invalid_request_error", err.field),
        );
        ctx.runtime.metrics.recordWebhookReceived({
          webhookName: name,
          status: "rejected",
        });
        return;
      }
      throw err;
    }
  };
}

/**
 * A genuine hit that starts no task: a repeat of a message already
 * accepted, GitHub's `ping`, or an event the binding's `events` filter
 * leaves out. Answered 200 so the sender records a delivery and does
 * not retry.
 */
function ignore(
  res: ServerResponse,
  ctx: HandlerContext,
  name: string,
  payload: Record<string, unknown>,
): void {
  ctx.runtime.metrics.recordWebhookReceived({ webhookName: name, status: "ignored" });
  sendJson(res, 200, { taskId: null, ...payload });
}

/**
 * Resolve `sessionId` for a webhook hit based on the binding's
 * `sessionMode`. The lookup side-effects only for `persistent`
 * mode — the first hit creates a fresh session via
 * `runtime.createSession` and persists the mapping so subsequent hits
 * (and process restarts) reuse the same id.
 */
function resolveWebhookSessionId(
  webhook: WebhookConfig,
  name: string,
  runtime: {
    createSession(input?: { metadata?: Record<string, unknown> }): {
      id: string;
    };
    webhookSessionStore: {
      get(name: string): string | null;
      set(name: string, sessionId: string): void;
    };
  },
): string | null {
  const mode = webhook.sessionMode ?? "ephemeral";
  if (mode === "ephemeral") return null;
  if (mode === "named") {
    return webhook.sessionId ?? null;
  }
  const existing = runtime.webhookSessionStore.get(name);
  if (existing) return existing;
  const fresh = runtime.createSession({
    metadata: { webhookName: name, webhookPersistent: true },
  });
  runtime.webhookSessionStore.set(name, fresh.id);
  return fresh.id;
}
