/**
 * The one GitHub credential the agent knows about.
 *
 * `GITHUB_TOKEN` is the name the rest of the codebase already reads —
 * the skill hub client, the llama backend installer and the app updater
 * all fall back to it for rate limits — and it is the name `gh` and the
 * GitHub Actions runner use. Storing the Integrations-hub token under
 * the same variable means one paste lights up every consumer, including
 * a `gh` invocation through `os.shell.run`, which inherits `process.env`.
 */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/**
 * The shapes GitHub issues today. Classic PATs (`ghp_`), fine-grained
 * PATs (`github_pat_`), OAuth tokens minted by `gh auth login` (`gho_`),
 * and the short-lived user-to-server / installation tokens (`ghu_`,
 * `ghs_`). Anything else is almost always a paste of the wrong thing —
 * a client secret, an SSH key, the token's *name* — and would otherwise
 * fail as an opaque 401 on first use.
 */
const TOKEN_SHAPE = /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/;

export function looksLikeGithubToken(raw: string): boolean {
  return TOKEN_SHAPE.test(raw.trim());
}

/**
 * Resolve the token. Explicit value wins (the test seam); otherwise the
 * env, treating blank as "not configured" so a stray `GITHUB_TOKEN=`
 * line in `.env` does not read as a real token.
 */
export function resolveGithubToken(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit !== undefined) return explicit;
  const raw = env[GITHUB_TOKEN_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Mask anything token-shaped in an error message before it reaches a
 * log line, a chat bubble or a trace. Git in particular echoes the
 * remote URL — and with it any credential embedded in one — into
 * stderr on failure.
 */
export function scrubGithubToken(message: string): string {
  return message
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "<token>")
    .replace(/github_pat_[A-Za-z0-9_]{40,}/g, "<token>")
    .replace(/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1<redacted>");
}

/** The error every GitHub-backed tool throws when there is no token. */
export const GITHUB_NOT_CONNECTED =
  "GitHub is not connected. Open the Integrations tab (or run /integrations github) and add a personal access token.";
