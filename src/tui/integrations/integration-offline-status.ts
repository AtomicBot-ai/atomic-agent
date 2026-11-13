import type { IntegrationStatus } from "../../integrations/index.js";

/**
 * Offline mode in the Integrations hub (ATO-1088).
 *
 * The messaging channels live on the internet: Telegram and Discord
 * keep a connection to their servers, Atomic Mail is a hosted inbox.
 * GitHub, Exa web search and Composio are hosted services too; their
 * tools refuse while offline, so the hub says they are paused as well.
 * While the network kill switch (ATO-1084) is on, the runtime does not
 * start them (or stops them when the switch goes on) and starts them
 * again when it goes off. Without this the hub would read "channel
 * failed to start" or a stale "channel up"; with it the operator sees
 * one plain line saying why.
 *
 * Pure: the caller passes whether offline mode is on.
 */
export const OFFLINE_PAUSED_DETAIL = "Paused: offline mode is on";

/** The integrations offline mode pauses: channels and hosted services. */
export const OFFLINE_PAUSED_INTEGRATIONS: ReadonlySet<string> = new Set([
  "telegram",
  "discord",
  "atomic-mail",
  "github",
  "exa",
  "composio",
]);

/**
 * The status the hub shows for `integrationId`: unchanged while online,
 * for integrations that are not channels, and for one that is not set
 * up yet (the setup hint stays useful offline); otherwise paused.
 */
export function offlineIntegrationStatus(
  integrationId: string,
  status: IntegrationStatus,
  offline: boolean,
): IntegrationStatus {
  if (!offline) return status;
  if (!OFFLINE_PAUSED_INTEGRATIONS.has(integrationId)) return status;
  if (status.level === "not_configured") return status;
  return { level: "configured", detail: OFFLINE_PAUSED_DETAIL };
}
