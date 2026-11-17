/**
 * What `atag serve --tunnel` is doing right now (ATO-625), for
 * `GET /api/webhooks`. One serve process runs at most one tunnel, so the
 * state is process-wide; serve writes it, the route only reads it.
 *
 * `publicUrl` is the tunnel's origin (`https://<name>.trycloudflare.com`
 * or the named tunnel's hostname); the webhook address is that plus
 * `/api/webhooks/<name>`. Nothing else is served at that origin.
 */
export interface WebhookTunnelStatus {
  state: "off" | "starting" | "up" | "failed";
  mode: "quick" | "named" | null;
  publicUrl: string | null;
  error: string | null;
}

const OFF: WebhookTunnelStatus = {
  state: "off",
  mode: null,
  publicUrl: null,
  error: null,
};

let current: WebhookTunnelStatus = OFF;

export function getWebhookTunnelStatus(): WebhookTunnelStatus {
  return current;
}

export function setWebhookTunnelStatus(next: WebhookTunnelStatus): void {
  current = { ...next };
}

export function resetWebhookTunnelStatus(): void {
  current = OFF;
}
