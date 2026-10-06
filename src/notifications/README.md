# Download notifications

Status: current
Owner: src/notifications/

Sends configured completion notices from detached download workers. Use recorded job outcomes, configured destinations and scrubbed errors.

Entry point: [download-notifier.ts](download-notifier.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/notifications` when tests are present; `npm run lint`; `npm run docs:check`.
