/**
 * Resolve the Composio API key.
 *
 * Mirrors `resolveLlmProviderApiKey` and the Telegram bot token: the
 * secret never lives in `config.json`, only in `<stateDir>/.env`
 * (0600), which `loadDotenvFromStateDir` has already folded into
 * `process.env` by the time bootstrap runs. Config carries the *name*
 * of the variable, following the `web.search.exa.apiKeyEnv`
 * precedent, so an operator can point at their own variable.
 */

/** Default env var the Integrations tab writes to. */
export const COMPOSIO_API_KEY_ENV = "COMPOSIO_API_KEY";

export interface ResolveComposioKeyOptions {
  /** Env var name from `config.composio.apiKeyEnv`. */
  apiKeyEnv?: string;
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Return the configured key, or `undefined` when unset.
 *
 * `undefined` is the integration's only gate: bootstrap mounts no
 * Composio MCP server without it, so no Composio tool is ever
 * registered and none can be called.
 */
export function resolveComposioApiKey(
  opts: ResolveComposioKeyOptions = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const name =
    opts.apiKeyEnv && opts.apiKeyEnv.length > 0
      ? opts.apiKeyEnv
      : COMPOSIO_API_KEY_ENV;
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
