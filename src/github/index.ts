/**
 * GitHub integration — token resolution, the REST client, and the two
 * pure helpers the git tools need. See AGENTS.md §"GitHub integration".
 */

export {
  GITHUB_NOT_CONNECTED,
  GITHUB_TOKEN_ENV,
  looksLikeGithubToken,
  resolveGithubToken,
  scrubGithubToken,
} from "./github-token.js";
export {
  formatRepoSlug,
  isGithubHttpsRemote,
  isGithubRemote,
  parseGithubRemote,
  parseRepoSlug,
} from "./parse-github-remote.js";
export type { GithubRepoRef } from "./parse-github-remote.js";
export {
  GITHUB_EXTRAHEADER_KEY,
  githubAuthGitEnv,
  githubAuthHeaderValue,
} from "./git-auth-header.js";
export {
  GITHUB_API_BASE,
  GITHUB_BODY_LIMIT,
  GithubApi,
  GithubApiError,
} from "./github-api.js";
export type {
  CreateIssueInput,
  CreatePullRequestInput,
  GithubApiOptions,
  GithubComment,
  GithubIdentity,
  GithubIssue,
  GithubPullRequest,
  GithubRepo,
} from "./github-api.js";
