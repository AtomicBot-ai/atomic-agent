import type { AnalyticsClient } from "./analytics-client.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";

/** Canonical PostHog event names emitted by the runtime. */
export const ANALYTICS_EVENTS = {
  appInstalled: "app_installed",
  appOpened: "app_opened",
  onboardingStep: "onboarding_step",
  modelConfigured: "model_configured",
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
 * Emit `app_opened` — once per process start, on every launch.
 *
 * The counterpart to `app_installed`, which fires once per install and
 * never again. Without this event an install that was downloaded and
 * never launched is indistinguishable from one that launched and got
 * stuck, so the two failure modes collapse into a single "never sent a
 * message" number that no dashboard can take apart.
 *
 * Deliberately carries no properties of its own — the client already
 * stamps `platform` and `app_version` on every event, which is the
 * whole dimension set this event needs.
 */
export function captureAppOpened(client: AnalyticsClient | null): void {
  if (!client) return;
  client.capture(ANALYTICS_EVENTS.appOpened);
}

/**
 * Emit `onboarding_step` when the first-run flow arrives at `step`.
 *
 * `step` is the `OnboardingStep` union from the TUI onboarding state
 * (`intro` / `choose` / `local_pick` / `cloud` / `finished` / …) — a
 * closed vocabulary of screen names, never free text and never
 * anything the operator typed. `outcome` is set only on the terminal
 * step and reports how the flow ended (`local` / `cloud` / `custom` /
 * `skipped`).
 *
 * This is what turns "55% never activated" into a funnel with a named
 * step where people leave.
 */
export function captureOnboardingStep(
  client: AnalyticsClient | null,
  step: string,
  outcome?: string,
): void {
  if (!client) return;
  client.capture(ANALYTICS_EVENTS.onboardingStep, {
    step,
    ...(outcome !== undefined ? { outcome } : {}),
  });
}

/**
 * Emit the one-time `model_configured` event: this install has a
 * working LLM backend for the first time.
 *
 * Fires on the first *verified* provider setup — the point where a
 * backend answered a probe, not where a key was merely typed in. Guarded
 * by the state store so it marks the transition rather than counting
 * reconfigurations; a user who later swaps providers does not re-fire it.
 *
 * Carries `{ provider, kind }` only: the provider id (`openrouter`,
 * `llama.cpp`, …) and whether the backend is `local` or `cloud`. Never
 * the key, the base URL, or a host — a self-hosted endpoint is part of
 * the operator's private infrastructure, so only the shape of the
 * choice leaves the machine.
 */
export function captureModelConfigured(
  client: AnalyticsClient | null,
  store: AnalyticsStateStore,
  context: { provider: string; kind: "local" | "cloud" },
): void {
  if (!client) return;
  if (store.isModelConfiguredSent()) return;
  client.capture(ANALYTICS_EVENTS.modelConfigured, {
    provider: context.provider,
    kind: context.kind,
  });
  store.markModelConfiguredSent();
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
