# GitHub API integration

Status: current
Owner: src/github/

Owns API/auth helpers for tool and UI consumers. Keep credentials out of persisted remote URLs and command diagnostics; use explicit API error parsing.

Entry point: [github-api.ts](github-api.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/github` when tests are present; `npm run lint`; `npm run docs:check`.
