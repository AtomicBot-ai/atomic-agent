# Tool result compression

Status: current
Owner: src/compressor/

Bounds stored tool observations. Tail versus head preservation is intentional, especially for shell check verdicts; compression and transcript rendering are distinct caps.

Entry point: [result-compressor.ts](result-compressor.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/compressor` when tests are present; `npm run lint`; `npm run docs:check`.
