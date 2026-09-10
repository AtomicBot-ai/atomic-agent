/**
 * Turn a git remote URL into `{ owner, repo }`.
 *
 * Every form git accepts for GitHub is covered — `https://`, `ssh://`,
 * the scp-like `git@github.com:owner/repo.git`, with or without the
 * `.git` suffix or a trailing slash. Anything that is not github.com
 * returns `null` rather than a guess: the tools that call this must
 * refuse to run a GitHub API call against a GitLab remote, not silently
 * target whatever the path happens to look like.
 */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

// `ssh.github.com:443` is GitHub's documented SSH-over-HTTPS-port host.
const HTTPS_OR_SSH =
  /^(?:https?|ssh|git):\/\/(?:[^@/:]+@)?(?:ssh\.)?github\.com(?::\d{1,5})?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
// The userinfo class excludes `/` and `:` so a URL of another host that
// merely *contains* `@github.com:` cannot masquerade as GitHub.
const SCP_LIKE = /^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

export function parseGithubRemote(url: string): GithubRepoRef | null {
  const trimmed = url.trim();
  const m = HTTPS_OR_SSH.exec(trimmed) ?? SCP_LIKE.exec(trimmed);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Parse an `owner/repo` slug as typed by the operator or the model.
 * A full GitHub URL is accepted too, since that is what people paste.
 */
export function parseRepoSlug(raw: string): GithubRepoRef | null {
  const trimmed = raw.trim();
  const fromUrl = parseGithubRemote(trimmed);
  if (fromUrl) return fromUrl;
  const m =
    /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(
      trimmed,
    );
  if (!m || !m[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

export function formatRepoSlug(ref: GithubRepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * True when a remote URL points at github.com — the only host the
 * token header may ever be attached to. Sending a GitHub token to any
 * other host would hand it to whoever runs that host.
 */
export function isGithubRemote(url: string): boolean {
  return parseGithubRemote(url) !== null;
}

/**
 * True only for an `https://github.com/…` remote — the one transport the
 * token header applies to. An SSH remote authenticates with the
 * operator's key; handing it the token as well buys nothing and would
 * report a push as token-authenticated when it was not.
 */
export function isGithubHttpsRemote(url: string): boolean {
  return /^https?:\/\//i.test(url.trim()) && parseGithubRemote(url) !== null;
}
