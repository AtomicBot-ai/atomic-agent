# Error reporting

Status: current
Owner: src/error-reporting/

Owns outbound error scrubbing/report envelopes and failure-safe delivery. Scrub credentials before external reports; local traces have a different privacy contract.

Entry point: [error-scrubber.ts](error-scrubber.ts). [Secret detector](secret-detector.ts) is the shared credential masker (vendor key shapes, PEM keys, URL passwords, secret-named pairs, exact known values) behind the scrubber's allowlisted message and the masking of tool output before the model reads it (`src/tools/tool-output-secrets.ts`); its patterns stay linear and leave hashes, UUIDs and base64 alone. [LLM failure tags](llm-failure-tags.ts) reduce the runtime's `llm_failure` turn context (provider, local engine, outage wait, engine process state, and the failed request's route and port class, never its address or port number; for a refused connection also whether the engine process was alive and a bucket of how long the turn waited) to fixed words and counts; anything outside a vocabulary is sent as `unknown`, and these tags stay out of the fingerprint. [Rate limit](sentry-rate-limit.ts) drops an event once the same grouping key (the fingerprint, else type + normalized message + top in-app frame) was sent 10 times in the last hour by this install; the counter is kept in `sentry-rate-limit.json` in the state dir (key hashes and timestamps only) so restarts do not reset it. Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/error-reporting` when tests are present; `npm run lint`; `npm run docs:check`.
