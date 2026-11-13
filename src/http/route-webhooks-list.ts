import { sendJson, type HttpHandler } from "./request-context.js";
import { getWebhookTunnelStatus } from "./webhook-tunnel-status.js";

/**
 * `GET /api/webhooks` (ATO-625) — the configured webhook bindings and
 * where each one is reached: the local path on this server and, while
 * `atag serve --tunnel` is up, the public address. A binding without a
 * `secret` gets no public address: the tunnel gateway refuses it.
 * Secrets are never returned, only whether one is set.
 */
export function createListWebhooksHandler(): HttpHandler {
  return (_req, res, ctx) => {
    const tunnel = getWebhookTunnelStatus();
    const publicBase = tunnel.state === "up" ? tunnel.publicUrl : null;
    const webhooks = Object.entries(ctx.runtime.config.webhooks).map(
      ([name, webhook]) => {
        const path = `/api/webhooks/${encodeURIComponent(name)}`;
        const hasSecret = typeof webhook.secret === "string" && webhook.secret.length > 0;
        return {
          name,
          path,
          hasSecret,
          sessionMode: webhook.sessionMode ?? "ephemeral",
          publicUrl: publicBase && hasSecret ? `${publicBase}${path}` : null,
        };
      },
    );
    sendJson(res, 200, {
      tasksEnabled: ctx.runtime.config.tasks.enabled,
      tunnel,
      webhooks,
    });
  };
}
