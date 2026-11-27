/**
 * GitHub integration — token resolution, the REST client, and the two
 * pure helpers the git tools need. See README.md.
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
export {
  fetchChecks,
  fetchJobLogTail,
  fetchPullRequestHead,
} from "./github-checks-api.js";
export {
  hasMergeConflict,
  parseCheckRuns,
  parseCommitStatuses,
  parsePullRequestHead,
  summarizeChecks,
} from "./github-checks.js";
export type {
  CheckItem,
  CheckVerdict,
  ChecksState,
  ChecksSummary,
  PullRequestHead,
} from "./github-checks.js";
export { extractLogTail, readBodyTail } from "./github-log-tail.js";
export type { LogTail } from "./github-log-tail.js";
export {
  AUTOFIX_MAX_ATTEMPTS_CEILING,
  DEFAULT_AUTOFIX_MAX_ATTEMPTS,
  checkAutofixPushTarget,
  clampMaxAttempts,
  decideAttempt,
  enableAutofix,
  recordAutofixPush,
} from "./pr-autofix-guard.js";
export type { AttemptDecision, AutofixState } from "./pr-autofix-guard.js";
export { AutofixStore, autofixKey, autofixStatePath, autofixWorktreeDir, parseAutofixKey } from "./pr-autofix-store.js";
export { FEEDBACK_MAX_ITEMS, fetchPrFeedback, selectFeedback } from "./github-pr-feedback.js";
export type { FeedbackItem, FeedbackKind, PrFeedback } from "./github-pr-feedback.js";
export {
  WATCH_DEFAULT_MINUTES,
  WATCH_MAX_MINUTES,
  WATCH_MIN_MINUTES,
  clampWatchMinutes,
  planWatchRound,
  startWatch,
  watchDue,
} from "./pr-autofix-watch-state.js";
export type { AutofixWatch, AutofixWatchNotify, WatchObservation, WatchReason } from "./pr-autofix-watch-state.js";
export { PrAutofixWatcher, buildWatchRoundMessage } from "./pr-autofix-watcher.js";
export type { PrAutofixWatcherOptions } from "./pr-autofix-watcher.js";
