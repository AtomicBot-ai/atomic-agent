import { KNOWN_SECRET_ENV_VARS, buildCommandEnv, isSecretEnvName } from "../../../sandbox/command-env.js";

/**
 * The environment a provider's `apiKeyCommand` runs with (ATO-1716).
 *
 * Bootstrap loads `<stateDir>/.env` into the agent's `process.env`, so a
 * key command used to inherit every provider key and bot token configured
 * here: a command for one provider could print another provider's key,
 * and that output is sent as the key to the first provider's `baseUrl`.
 * Now it gets the same filtered environment as an agent shell command
 * (`buildCommandEnv`, ATO-347): PATH, HOME, locale and the rest of the
 * working environment stay; secret-looking names go.
 *
 * A key command is a credential helper, though, and some helpers need
 * their own sign-in that lives in the environment. Those names are let
 * back in, unless they are one of the agent's known provider or bot
 * keys (`KNOWN_SECRET_ENV_VARS`, for example `AWS_BEARER_TOKEN_BEDROCK`
 * or `GH_TOKEN`):
 *  - password managers: `OP_SESSION_*` and `OP_SERVICE_ACCOUNT_TOKEN`
 *    (1Password `op`), `BW_SESSION` (Bitwarden `bw`), `VAULT_TOKEN`
 *    (HashiCorp Vault);
 *  - cloud CLIs that print access tokens: `AWS_*`, `AZURE_*`,
 *    `CLOUDSDK_*` and `GOOGLE_APPLICATION_CREDENTIALS` (gcloud).
 *
 * Precedent: Codex `shell_environment_policy` drops `*KEY*`, `*SECRET*`,
 * `*TOKEN*` from the environment of commands it spawns by default.
 */
const CREDENTIAL_HELPER_ENV =
  /^(OP_SESSION_.+|OP_SERVICE_ACCOUNT_TOKEN|BW_SESSION|VAULT_TOKEN|AWS_.+|AZURE_.+|CLOUDSDK_.+|GOOGLE_APPLICATION_CREDENTIALS)$/;

const AGENT_KEYS = new Set(KNOWN_SECRET_ENV_VARS.map((name) => name.toUpperCase()));

export function buildApiKeyCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const passthrough: string[] = [];
  for (const name of Object.keys(base)) {
    const upper = name.toUpperCase();
    if (!isSecretEnvName(name) || AGENT_KEYS.has(upper)) continue;
    if (CREDENTIAL_HELPER_ENV.test(upper)) passthrough.push(name);
  }
  return buildCommandEnv(base, passthrough);
}
