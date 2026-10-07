# Analytics and opt-out

Status: current
Owner: src/analytics/

Owns product telemetry and usage metering. Preserve opt-out/kill-switch handling and sanitized dimensions; distinguish product analytics from local trace capture.

Entry point: [analytics-client.ts](analytics-client.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/analytics` when tests are present; `npm run lint`; `npm run docs:check`.
