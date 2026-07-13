/**
 * Hardcoded PostHog project connection. The project API key is a
 * *public* ingestion key (safe to ship in client code — it can only
 * write events, never read them), so it lives inline rather than in
 * `.env` / user config. Region is PostHog Cloud US.
 *
 * If the key is ever set to {@link POSTHOG_PLACEHOLDER_KEY}, the
 * analytics client short-circuits and never opens a connection — this
 * lets a build ship with analytics stubbed out.
 */
export const POSTHOG_PROJECT_KEY: string =
  "phc_vUYmW2qixSnPt4qTZBTWaVFw3JXxyZi8iEiG5TCDYkoH";

export const POSTHOG_HOST = "https://us.i.posthog.com";

/** Sentinel that disables analytics when used as the project key. */
export const POSTHOG_PLACEHOLDER_KEY = "PLACEHOLDER";
