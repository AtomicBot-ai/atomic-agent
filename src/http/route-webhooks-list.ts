import {
  getConfig,
  readUserConfigSnapshotSync,
  type WebhookConfig,
} from "../config/index.js";
import {
  WEBHOOK_VERIFY_SCHEMES,
  type WebhookVerifyScheme,
} from "../config/webhook-config.js";

import { sendJson, type HttpHandler } from "./request-context.js";
import { getWebhookTunnelStatus } from "./webhook-tunnel-status.js";

/**
 * One binding as `GET /api/webhooks` shows it. Never carries the secret,
 * only whether one is set.
 */
export interface WebhookListItem {
  name: string;
  /** Path on this agent's HTTP server (and on the tunnel origin). */
  path: string;
  hasSecret: boolean;
  sessionMode: "ephemeral" | "persistent" | "named";
  /** Public address while the tunnel is up; only for a live binding with a secret. */
  publicUrl: string | null;
  /** ATO-445: how a hit is authenticated (`secret` when unset). */
  verify: WebhookVerifyScheme;
  /** ATO-445: the binding's event filter, when it has one. */
  events?: string[];
  /** ATO-445: the task message template. */
  userMessageTemplate: string;
  /**
   * ATO-445: loaded in the running agent. False for a binding added to
   * `config.json` by hand since the agent started; it answers after a
   * restart.
   */
  live: boolean;
}

export function webhookListItem(
  name: string,
  webhook: WebhookConfig,
  live: boolean,
  publicBase: string | null,
): WebhookListItem {
  const path = `/api/webhooks/${encodeURIComponent(name)}`;
  const hasSecret = typeof webhook.secret === "string" && webhook.secret.length > 0;
  return {
    name,
    path,
    hasSecret,
    sessionMode: webhook.sessionMode ?? "ephemeral",
    publicUrl: publicBase && hasSecret && live ? `${publicBase}${path}` : null,
    verify: webhook.verify ?? "secret",
    ...(webhook.events ? { events: [...webhook.events] } : {}),
    userMessageTemplate: webhook.userMessageTemplate,
    live,
  };
}

/** The tunnel's origin while it is up, else null. */
export function webhookPublicBase(): string | null {
  const tunnel = getWebhookTunnelStatus();
  return tunnel.state === "up" ? tunnel.publicUrl : null;
}

/**
 * `GET /api/webhooks` (ATO-625) — the configured webhook bindings and
 * where each one is reached: the local path on this server and, while
 * `atag serve --tunnel` is up, the public address. A binding without a
 * `secret` gets no public address: the tunnel gateway refuses it.
 * Secrets are never returned, only whether one is set.
 *
 * ATO-445 adds what the desktop's Webhooks screen needs: each binding's
 * `verify`, `events`, `userMessageTemplate` and `live`, bindings saved
 * in `config.json` but not loaded yet (`live: false`), and the list of
 * `verify` values (`presets`) for the add form.
 */
export function createListWebhooksHandler(): HttpHandler {
  return (_req, res, ctx) => {
    const tunnel = getWebhookTunnelStatus();
    const publicBase = webhookPublicBase();
    const live = ctx.runtime.config.webhooks;
    const webhooks = Object.entries(live).map(([name, webhook]) =>
      webhookListItem(name, webhook, true, publicBase),
    );
    for (const [name, webhook] of Object.entries(savedWebhooks())) {
      if (Object.hasOwn(live, name)) continue;
      webhooks.push(webhookListItem(name, webhook, false, publicBase));
    }
    sendJson(res, 200, {
      tasksEnabled: ctx.runtime.config.tasks.enabled,
      tunnel,
      webhooks,
      presets: WEBHOOK_VERIFY_SCHEMES,
    });
  };
}

/**
 * Bindings in the user's `config.json`. A missing or unreadable file only
 * means there is nothing extra to show, so the list never fails on it.
 */
function savedWebhooks(): Record<string, WebhookConfig> {
  try {
    const path = getConfig().paths.userConfigFile;
    return readUserConfigSnapshotSync(path).config.webhooks ?? {};
  } catch {
    return {};
  }
}
