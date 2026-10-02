/**
 * Process-level kill switch for anonymous analytics AND crash reporting.
 * `ATOMIC_AGENT_ANALYTICS=off` turns both off for this process whatever
 * `config.analytics.enabled` says: no PostHog events, no Sentry reports,
 * and no write to the shared install id file. The desktop app sets it on
 * the agent it spawns for smoke / test runs. It is not persisted, so it
 * never changes the operator's saved choice.
 */
export const ANALYTICS_KILL_SWITCH_ENV = "ATOMIC_AGENT_ANALYTICS";

const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

/** True when the environment forces analytics and crash reports off. */
export function isAnalyticsKilledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ANALYTICS_KILL_SWITCH_ENV];
  if (typeof raw !== "string") return false;
  return OFF_VALUES.has(raw.trim().toLowerCase());
}
