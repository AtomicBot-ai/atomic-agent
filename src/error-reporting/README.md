# Error reporting

Status: current
Owner: src/error-reporting/

Owns outbound error scrubbing/report envelopes and failure-safe delivery. Scrub credentials before external reports; local traces have a different privacy contract.

Entry point: [error-scrubber.ts](error-scrubber.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/error-reporting` when tests are present; `npm run lint`; `npm run docs:check`.
