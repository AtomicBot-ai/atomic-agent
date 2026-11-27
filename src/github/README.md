# GitHub API integration

Status: current
Owner: src/github/

Owns API/auth helpers for tool and UI consumers. Keep credentials out of persisted remote URLs and command diagnostics; use explicit API error parsing.

Entry point: [github-api.ts](github-api.ts).

CI autofix (ATO-2331): [github-checks.ts](github-checks.ts) folds check runs and commit statuses on a PR head into one verdict (newest run per name; the combined status state is ignored because GitHub reports `pending` for a commit with no statuses); [github-log-tail.ts](github-log-tail.ts) keeps the last 256 KiB of an Actions job log while reading, then the cleaned last lines plus `##[error]` lines. [pr-autofix-guard.ts](pr-autofix-guard.ts) holds the push rules (open PR, head branch in the same repo, never the default, a protected name or the base) and the attempt cap (default 3 per PR head; a push by a person restarts it, a GitHub head still at the sha seen before our push does not); [pr-autofix-store.ts](pr-autofix-store.ts) keeps that state in `<stateDir>/pr-autofix/state.json`, a protected `state_secret` path; the worktree folder is always derived, never read from that file. The tools are `github.pr.checks` and `github.pr.autofix` in `src/tools/github/`; the loop is the `pr-autofix` starter skill. Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/github` when tests are present; `npm run lint`; `npm run docs:check`.
