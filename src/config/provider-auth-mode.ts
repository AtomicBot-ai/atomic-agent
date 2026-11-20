import type { UserLlmProviderEntry } from "./llm-config.js";

/**
 * Provider kind that authenticates by delegating to an already-signed-in
 * vendor CLI (`claude`, `codex`) instead of carrying an API key. Lives
 * here rather than in the provider folder so the config and TUI layers
 * can classify an entry without importing the provider implementation.
 */
export const SUBSCRIPTION_CLI_KIND = "subscription-cli";

/**
 * EXPERIMENTAL (ATO-1448): provider kind that signs in to a ChatGPT plan
 * itself (OAuth, the way the Codex CLI does) and keeps the tokens in
 * `<stateDir>/auth/chatgpt.json`, never in config.json. The Codex CLI
 * kind above stays the primary path.
 */
export const SUBSCRIPTION_OAUTH_KIND = "subscription-oauth";

/** Services a `subscription-oauth` entry can sign in to. */
export const SUBSCRIPTION_OAUTH_SERVICES = ["chatgpt"] as const;
export type SubscriptionOAuthService = (typeof SUBSCRIPTION_OAUTH_SERVICES)[number];

/**
 * Whether this entry gets its credentials from an external CLI's own
 * session rather than from an API key we resolve.
 *
 * Callers use it wherever "has no API key" would otherwise be read as
 * "not configured": the TUI startup gate and the providers panel both
 * treat a keyless entry as unusable, which is right for every kind that
 * existed before subscription CLIs and wrong for this one.
 *
 * Deliberately does NOT probe the binary. Both call sites are on
 * synchronous hot paths (startup, panel refresh), spawning the CLI there
 * would add ~800ms per TUI launch, and a transient PATH problem would
 * bounce the user into the local-model setup wizard. A missing binary
 * surfaces on the first completion and through `health()` instead.
 *
 * The experimental `subscription-oauth` kind is keyless the same way
 * (ATO-1453): its sign-in lives in its own token file, and like the
 * CLI's it is not read here; a missing or expired sign-in surfaces on
 * the first completion as "run `atag login chatgpt`".
 */
export function usesExternalCliAuth(
  entry: Pick<UserLlmProviderEntry, "kind" | "subscriptionCli">,
): boolean {
  if (entry.kind === SUBSCRIPTION_OAUTH_KIND) return true;
  return (
    entry.kind === SUBSCRIPTION_CLI_KIND && Boolean(entry.subscriptionCli?.cli)
  );
}
