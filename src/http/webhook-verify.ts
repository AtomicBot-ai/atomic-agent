import type { IncomingMessage } from "node:http";

import { getHeader } from "./request-context.js";
import { secretEquals } from "./secret-equal.js";
import {
  verifyGithubSignature,
  verifyStandardWebhook,
  verifyStripeSignature,
  type SignatureFailure,
} from "./webhook-signature.js";
import type { WebhookConfig } from "../config/index.js";

/**
 * Per-binding authentication and event naming for
 * `POST /api/webhooks/:name` (ATO-438). The route stays the owner of the
 * request flow; this module only answers "is this hit genuine" and
 * "which event is it".
 */

export type WebhookAuthResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: SignatureFailure | "invalid_secret" };

/**
 * The shared-secret scheme: the `x-webhook-secret` header must equal the
 * configured secret. A binding without a secret accepts every hit (the
 * global API key still applies). Checked before the body is read, as it
 * always was.
 */
export function checkSharedSecret(
  webhook: WebhookConfig,
  req: IncomingMessage,
): boolean {
  if (!webhook.secret) return true;
  return secretEquals(getHeader(req, "x-webhook-secret"), webhook.secret);
}

/**
 * The signed schemes, over the exact body bytes. `messageId` is the
 * Standard Webhooks `webhook-id`, which the route uses to drop repeats;
 * GitHub's delivery id is not used for that, because "Redeliver" in
 * GitHub's UI sends the same id again on purpose. The tunnel gateway
 * (ATO-625) dedupes every signed delivery id anyway, from
 * `describeWebhookEvent` (`dedupeDeliveries` in the route).
 */
export function verifySignedWebhook(
  webhook: WebhookConfig,
  req: IncomingMessage,
  rawBody: Buffer,
  nowMs: number,
): WebhookAuthResult {
  const secret = webhook.secret ?? "";
  if (webhook.verify === "github") {
    const check = verifyGithubSignature(
      rawBody,
      getHeader(req, "x-hub-signature-256"),
      secret,
    );
    return check.ok ? { ok: true, messageId: null } : check;
  }
  if (webhook.verify === "standard-webhooks") {
    const id = getHeader(req, "webhook-id");
    const check = verifyStandardWebhook(
      rawBody,
      {
        id,
        timestamp: getHeader(req, "webhook-timestamp"),
        signature: getHeader(req, "webhook-signature"),
      },
      secret,
      nowMs,
    );
    return check.ok ? { ok: true, messageId: id } : check;
  }
  if (webhook.verify === "stripe") {
    const check = verifyStripeSignature(
      rawBody,
      getHeader(req, "stripe-signature"),
      secret,
      nowMs,
    );
    return check.ok ? { ok: true, messageId: null } : check;
  }
  return checkSharedSecret(webhook, req)
    ? { ok: true, messageId: null }
    : { ok: false, reason: "invalid_secret" };
}

/** What a hit is, for template variables and the `events` filter. */
export interface WebhookEvent {
  /** GitHub `X-GitHub-Event`, or the Standard Webhooks / Stripe payload `type`. */
  event: string;
  /** GitHub payload `action` (`opened`, `closed`, ...), else empty. */
  action: string;
  /** `X-GitHub-Delivery`, `webhook-id` or the Stripe event `id`, else empty. */
  delivery: string;
}

export function describeWebhookEvent(
  webhook: WebhookConfig,
  req: IncomingMessage,
  body: unknown,
): WebhookEvent {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (webhook.verify === "github") {
    return {
      event: getHeader(req, "x-github-event") ?? "",
      action: typeof record.action === "string" ? record.action : "",
      delivery: getHeader(req, "x-github-delivery") ?? "",
    };
  }
  if (webhook.verify === "standard-webhooks") {
    return {
      event: typeof record.type === "string" ? record.type : "",
      action: "",
      delivery: getHeader(req, "webhook-id") ?? "",
    };
  }
  if (webhook.verify === "stripe") {
    /* Stripe signs no id header; the event id (`evt_...`) is in the body. */
    return {
      event: typeof record.type === "string" ? record.type : "",
      action: "",
      delivery: typeof record.id === "string" ? record.id : "",
    };
  }
  return { event: "", action: "", delivery: "" };
}

/**
 * `events` entries match the event name (`pull_request`) or the event
 * plus its action (`pull_request.opened`). No filter lets everything in.
 */
export function webhookEventAllowed(
  events: readonly string[] | undefined,
  hit: WebhookEvent,
): boolean {
  if (!events) return true;
  if (!hit.event) return false;
  const withAction = hit.action ? `${hit.event}.${hit.action}` : null;
  return events.some((entry) => entry === hit.event || entry === withAction);
}
