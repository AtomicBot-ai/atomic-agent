/**
 * Process-level kill switch for anonymous analytics AND crash reporting.
 * `ATOMIC_AGENT_ANALYTICS=off` turns both off for this process whatever
 * `config.analytics.enabled` says: no PostHog events, no Sentry reports,
 * and no write to the shared install id file. The desktop app sets it on
 * the agent it spawns for smoke / test runs. It is not persisted, so it
 * never changes the operator's saved choice.
 *
 * The cross-tool `DO_NOT_TRACK=1` convention (consoledonottrack.com)
 * does the same (ATO-1189): a user who set it once for every CLI gets no
 * analytics and no crash reports from the agent either.
 */
export const ANALYTICS_KILL_SWITCH_ENV = "ATOMIC_AGENT_ANALYTICS";
export const DO_NOT_TRACK_ENV = "DO_NOT_TRACK";

const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled"]);
/** `DO_NOT_TRACK` values that opt out; `0`, `false` or empty do not. */
const DO_NOT_TRACK_ON_VALUES = new Set(["1", "true", "yes", "on"]);

/** True when `DO_NOT_TRACK` asks for no tracking. */
export function isDoNotTrackSet(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DO_NOT_TRACK_ENV];
  if (typeof raw !== "string") return false;
  return DO_NOT_TRACK_ON_VALUES.has(raw.trim().toLowerCase());
}

/** True when the environment forces analytics and crash reports off. */
export function isAnalyticsKilledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isDoNotTrackSet(env)) return true;
  const raw = env[ANALYTICS_KILL_SWITCH_ENV];
  if (typeof raw !== "string") return false;
  return OFF_VALUES.has(raw.trim().toLowerCase());
}
