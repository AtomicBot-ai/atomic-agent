/**
 * The environment a vendor CLI is spawned with: the agent's own, minus
 * the variables that would move the CLI off the user's subscription.
 *
 * The agent's environment is not the user's shell. It carries the keys
 * of every other provider configured here — the `anthropic` provider's
 * `ANTHROPIC_API_KEY` from `.env` among them — and `claude` prefers an
 * API key it finds in its environment over the subscription it is
 * signed in with. Inherited untouched, a user who picked "Claude Code
 * subscription" was billed per token on that key, or saw the turn fail
 * with "credit balance too low" on an account they never meant to use.
 * Someone who wants API billing has the provider for that.
 *
 * Matched without regard to case: Windows environment names are
 * case-insensitive, so `Anthropic_Api_Key` reaches the CLI as the same
 * variable.
 */
export function cliChildEnv(
  strip: readonly string[] | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (strip === undefined || strip.length === 0) return base;
  const drop = new Set(strip.map((key) => key.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!drop.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}
