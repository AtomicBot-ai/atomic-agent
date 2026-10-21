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
  analyticsDisabled: "analytics_disabled",
  localEngineFailed: "local_engine_failed",
  imageGenerated: "image_generated",
} as const;

/**
 * Which engine served a local turn: Atomic Core, our own managed
 * llama-server, or a server the operator runs (external mode or a custom
 * llama-server provider). A fixed word, never a URL or a path.
 */
export type LocalEngine = "atomic-core" | "llama-server" | "external";

/** Where an analytics opt-out was made. */
export type AnalyticsDisabledVia = "settings" | "slash" | "config";

/** Fixed context attached to the one-time `app_installed` event. */
export interface AppInstalledContext {
  /** Install channel enum (also stamped globally). */
  installChannel?: string;
  /** Whether the other surface (desktop / terminal) ran on this machine. */
  otherSurfaceInstalled?: boolean;
}

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
 *  - `localEngine` — for a local turn only, which engine served it
 *                    (`LocalEngine`). Omitted for cloud turns.
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
  localEngine?: LocalEngine;
}

/**
 * Emit the one-time `app_installed` event. No-ops when analytics is
 * disabled (`client` is null) or the event was already sent for this
 * install.
 */
export function captureAppInstalled(
  client: AnalyticsClient | null,
  store: AnalyticsStateStore,
  context: AppInstalledContext = {},
): void {
  if (!client) return;
  if (store.isAppInstalledSent()) return;
  client.capture(ANALYTICS_EVENTS.appInstalled, {
    ...(context.installChannel !== undefined
      ? { install_channel: context.installChannel }
      : {}),
    ...(context.otherSurfaceInstalled !== undefined
      ? { other_surface_installed: context.otherSurfaceInstalled }
      : {}),
  });
  store.markAppInstalledSent();
}

/**
 * Emit `analytics_disabled` — the last event this install sends before
 * the operator's opt-out takes effect. Callers fire it right BEFORE
 * tearing the client down so the shutdown flush delivers it. Carries
 * `via` (where the switch was flipped) and `days_since_install` (omitted
 * for installs that predate the stored install timestamp).
 */
export function captureAnalyticsDisabled(
  client: AnalyticsClient | null,
  store: AnalyticsStateStore,
  via: AnalyticsDisabledVia,
): void {
  if (!client) return;
  const days = store.getDaysSinceInstall();
  client.capture(ANALYTICS_EVENTS.analyticsDisabled, {
    via,
    ...(days !== undefined ? { days_since_install: days } : {}),
  });
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
    ...(context.latencyMs !== undefined
      ? { latency_ms: context.latencyMs }
      : {}),
    ...(context.stepCount !== undefined
      ? { step_count: context.stepCount }
      : {}),
    ...(context.outcome !== undefined ? { outcome: context.outcome } : {}),
    ...(context.promptTokens !== undefined
      ? { prompt_tokens: context.promptTokens }
      : {}),
    ...(context.completionTokens !== undefined
      ? { completion_tokens: context.completionTokens }
      : {}),
    ...(context.costUsd !== undefined ? { cost_usd: context.costUsd } : {}),
    ...(context.localEngine !== undefined
      ? { local_engine: context.localEngine }
      : {}),
  });
}

/**
 * Context of `local_engine_failed`. `stage` and `reasonCode` come from
 * the engine's closed vocabulary (`download` / `verify` / `backend` /
 * `start`; `network`, `checksum`, …). Anything outside a short lowercase
 * word is sent as `unknown`, so a path, a URL or an error message can
 * never leave the machine through this event.
 */
export interface LocalEngineFailedContext {
  engine: "atomic-core" | "llama-server";
  stage: string;
  reasonCode: string;
}

const FIXED_WORD = /^[a-z][a-z_]{0,23}$/;
function fixedWord(value: string): string {
  return FIXED_WORD.test(value) ? value : "unknown";
}

/**
 * Emit `local_engine_failed` when the local engine could not be installed
 * or started and the operator was shown the way forward (retry, or
 * llama.cpp). Carries `{ engine, stage, reason_code }` only. No-ops when
 * analytics is disabled.
 */
export function captureLocalEngineFailed(
  client: AnalyticsClient | null,
  context: LocalEngineFailedContext,
): void {
  if (!client) return;
  client.capture(ANALYTICS_EVENTS.localEngineFailed, {
    engine: context.engine === "llama-server" ? "llama-server" : "atomic-core",
    stage: fixedWord(context.stage),
    reason_code: fixedWord(context.reasonCode),
  });
}

/**
 * Context of `image_generated`, one per `image.generate` call. Shape
 * only: where it ran, which model, how long, how many pictures and
 * whether it worked. Never the prompt, a path or Core's error message;
 * `errorCode` is Core's closed code (`REMOTE_QUOTA`, `GPU_BUSY`, ...),
 * lowercased, or `unknown`.
 */
export interface ImageGeneratedContext {
  kind: "cloud" | "local";
  /** The catalog id (`google/gemini-nano-banana-2.1`) or `local`. */
  model: string;
  durationMs: number;
  success: boolean;
  count: number;
  errorCode?: string;
}

/** A model id as catalogs spell it: `vendor/name-1.2`. Anything else is `unknown`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;

/** Emit `image_generated`. No-ops when analytics is disabled. */
export function captureImageGenerated(
  client: AnalyticsClient | null,
  context: ImageGeneratedContext,
): void {
  if (!client) return;
  client.capture(ANALYTICS_EVENTS.imageGenerated, {
    kind: context.kind === "local" ? "local" : "cloud",
    model: MODEL_ID.test(context.model) ? context.model : "unknown",
    duration_ms: Math.max(0, Math.round(context.durationMs)),
    success: context.success,
    count: Math.max(0, Math.trunc(context.count)),
    ...(context.errorCode !== undefined ? { error_code: fixedWord(context.errorCode.toLowerCase()) } : {}),
  });
}
