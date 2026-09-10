/**
 * How a GitHub token reaches git without ever being written down.
 *
 * The token from the Integrations hub lives in `process.env.GITHUB_TOKEN`.
 * For a network verb the tool copies it into a variable set only on the
 * child git process and points git at an inline credential helper that
 * echoes it back — so the token is never an argv element (visible in
 * `ps`), never part of a remote URL, and never lands in `.git/config`.
 * The helper is bound to `https://github.com` only, so a remote on any
 * other host never sees it. Tokens are scrubbed from git's output before
 * it reaches the transcript or the trace.
 */

/** Env var the child git process reads the token from. Never exported to `process.env`. */
export const GIT_CREDENTIAL_ENV = "ATOMIC_AGENT_GIT_CREDENTIAL";

/** The hub's env var for the token — the name `gh` and the skills hub read too. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

const GITHUB_CREDENTIAL_KEY = "credential.https://github.com.helper";

/**
 * Inline helper: git runs it through `sh`, which ships with git on every
 * platform. Only the `get` action prints anything; `store` / `erase`
 * fall through silently so git never tries to persist the token.
 */
const INLINE_HELPER = `!f() { [ "$1" = get ] || exit 0; echo username=x-access-token; echo "password=$${GIT_CREDENTIAL_ENV}"; }; f`;

export interface CredentialInjection {
  /** `-c` pairs to put before the git subcommand. */
  args: readonly string[];
  /** Extra environment for the child only. */
  env: NodeJS.ProcessEnv;
}

/**
 * Build the argv + env that make a GitHub token available to one git
 * run. With no token the result is empty and git falls back to whatever
 * the operator already has — SSH keys, the OS keychain, `gh`'s helper —
 * exactly as it would in their own terminal.
 */
export function buildCredentialInjection(
  token: string | undefined,
): CredentialInjection {
  const trimmed = token?.trim();
  if (!trimmed) return { args: [], env: {} };
  return {
    args: [
      // An empty value resets the helper list for this URL so a stale
      // keychain entry cannot answer for github.com with another identity.
      "-c",
      `${GITHUB_CREDENTIAL_KEY}=`,
      "-c",
      `${GITHUB_CREDENTIAL_KEY}=${INLINE_HELPER}`,
    ],
    env: { [GIT_CREDENTIAL_ENV]: trimmed },
  };
}

/** Read the hub's token from an environment (injectable for tests). */
export function readGithubToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[GITHUB_TOKEN_ENV]?.trim();
  return raw ? raw : undefined;
}

/**
 * `https://user:token@host/…` and `https://token@host/…` would persist
 * the credential in `.git/config` the moment the remote is added, and
 * print it in every `git remote -v`. Refused at entry, for any host.
 */
export function hasEmbeddedUserinfo(url: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url.trim());
  if (!match) return false;
  return match[2]!.includes("@");
}

/**
 * Replace every occurrence of `secret` in `text` — git echoes URLs in
 * its progress and error output, and a helper misfire could print the
 * token itself. Cheap, and applied to every network verb's output.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  const trimmed = secret?.trim();
  if (!trimmed || text.length === 0) return text;
  return text.split(trimmed).join("***");
}

/**
 * SSH remotes must not park the turn on a passphrase or host-key prompt.
 * `BatchMode=yes` still uses the agent's keys; it only turns a prompt
 * into a failure with a reason. The operator's own `GIT_SSH_COMMAND`
 * wins when set.
 */
export function sshBatchEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (env.GIT_SSH_COMMAND) return {};
  return { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
}
