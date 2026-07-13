import type { AnalyticsClient } from "./analytics-client.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";

/** Canonical PostHog event names emitted by the runtime. */
export const ANALYTICS_EVENTS = {
  appInstalled: "app_installed",
  messageSent: "message_sent",
  firstMessageSent: "first_message_sent",
} as const;

/**
 * Non-sensitive context attached to message events. Only the active LLM
 * provider name and model identifier — never message content, file
 * paths, tool arguments, or any user data.
 */
export interface MessageEventContext {
  provider: string;
  model: string;
}

/**
 * Emit the one-time `app_installed` event. No-ops when analytics is
 * disabled (`client` is null) or the event was already sent for this
 * install.
 */
export function captureAppInstalled(
  client: AnalyticsClient | null,
  store: AnalyticsStateStore,
): void {
  if (!client) return;
  if (store.isAppInstalledSent()) return;
  client.capture(ANALYTICS_EVENTS.appInstalled);
  store.markAppInstalledSent();
}

/**
 * Emit `message_sent` for every human-originated turn, plus the
 * one-time `first_message_sent` on the very first message this install
 * ever sends. Both carry only `{ provider, model }`. No-ops when
 * analytics is disabled.
 */
export function captureMessageSent(
  client: AnalyticsClient | null,
  store: AnalyticsStateStore,
  context: MessageEventContext,
): void {
  if (!client) return;
  const properties = { provider: context.provider, model: context.model };
  if (!store.isFirstMessageSent()) {
    client.capture(ANALYTICS_EVENTS.firstMessageSent, properties);
    store.markFirstMessageSent();
  }
  client.capture(ANALYTICS_EVENTS.messageSent, properties);
}
