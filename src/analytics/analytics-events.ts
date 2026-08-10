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
 *
 * The optional shape metrics below describe the *cost/shape* of the turn,
 * never its content. All are attached to `message_sent` only, never to
 * `first_message_sent`, and each is omitted when the caller cannot
 * measure it:
 *  - `latencyMs`   — wall-clock duration of the turn (submit -> final
 *                    assistant response) in milliseconds.
 *  - `stepCount`   — number of agent steps taken (0..N tool steps + reply).
 *                    A proxy for "how much work the turn required".
 *  - `outcome`     — how the turn ended: `reply` / `finish` / `max_steps`
 *                    / `cancelled` / `failed`. `max_steps` means the reply
 *                    was cut off by the step budget.
 *  - `promptTokens` / `completionTokens`
 *                  — tokens the turn consumed, summed across every LLM
 *                    call it made. Reported by the provider's `usage`
 *                    block; omitted when the provider reports none.
 *  - `costUsd`     — estimated spend for the turn, from the same token
 *                    counts times per-model pricing. Omitted when the
 *                    model carries no pricing, which is the normal case
 *                    for local runners — a free turn reports no cost
 *                    rather than a zero one.
 */
export interface MessageEventContext {
  provider: string;
  model: string;
  latencyMs?: number;
  stepCount?: number;
  outcome?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
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
 * ever sends. Both carry `{ provider, model }`; `message_sent` also
 * carries `latency_ms` when the caller measured the turn duration, plus
 * token counts and estimated spend when the provider reported usage.
 * No-ops when analytics is disabled.
 */
export function captureMessageSent(
  client: AnalyticsClient | null,
  store: AnalyticsStateStore,
  context: MessageEventContext,
): void {
  if (!client) return;
  const base = { provider: context.provider, model: context.model };
  if (!store.isFirstMessageSent()) {
    client.capture(ANALYTICS_EVENTS.firstMessageSent, base);
    store.markFirstMessageSent();
  }
  client.capture(ANALYTICS_EVENTS.messageSent, {
    ...base,
    ...(context.latencyMs !== undefined ? { latency_ms: context.latencyMs } : {}),
    ...(context.stepCount !== undefined ? { step_count: context.stepCount } : {}),
    ...(context.outcome !== undefined ? { outcome: context.outcome } : {}),
    ...(context.promptTokens !== undefined
      ? { prompt_tokens: context.promptTokens }
      : {}),
    ...(context.completionTokens !== undefined
      ? { completion_tokens: context.completionTokens }
      : {}),
    ...(context.costUsd !== undefined ? { cost_usd: context.costUsd } : {}),
  });
}
