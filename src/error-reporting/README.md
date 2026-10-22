# Error reporting

Status: current
Owner: src/error-reporting/

Owns outbound error scrubbing/report envelopes and failure-safe delivery. Scrub credentials before external reports; local traces have a different privacy contract.

Entry point: [error-scrubber.ts](error-scrubber.ts). [LLM failure tags](llm-failure-tags.ts) reduce the runtime's `llm_failure` turn context (provider, local engine, outage wait, engine process state) to fixed words and counts; anything outside a vocabulary is sent as `unknown`, and these tags stay out of the fingerprint. Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/error-reporting` when tests are present; `npm run lint`; `npm run docs:check`.
