# Error reporting

Status: current
Owner: src/error-reporting/

Owns outbound error scrubbing/report envelopes and failure-safe delivery. Scrub credentials before external reports; local traces have a different privacy contract.

Entry point: [error-scrubber.ts](error-scrubber.ts). [Secret detector](secret-detector.ts) is the shared credential masker (vendor key shapes, PEM keys, URL passwords, secret-named pairs, exact known values) behind the scrubber's allowlisted message and the masking of tool output before the model reads it (`src/tools/tool-output-secrets.ts`); its patterns stay linear and leave hashes, UUIDs and base64 alone. [LLM failure tags](llm-failure-tags.ts) reduce the runtime's `llm_failure` turn context (provider, local engine, outage wait, engine process state, and the failed request's route and port class, never its address or port number) to fixed words and counts; anything outside a vocabulary is sent as `unknown`, and these tags stay out of the fingerprint. Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/error-reporting` when tests are present; `npm run lint`; `npm run docs:check`.
