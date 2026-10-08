# Tool result compression

Status: current
Owner: src/compressor/

Bounds local tool observations. Tail versus head preservation is intentional, especially for shell check verdicts; compression and transcript rendering are distinct local caps.

The compressor also retains the exact obtained output in non-enumerable, transient fields. The tool registry promotes that output into the result summary in `cloud` mode before transcript persistence; cloud batch commit skips the shared summary cap. Local serialization and summaries keep their existing shape. Wrappers that add warnings use `retainToolOutput` so the complete output carries the same warnings. Explicit retrieval ranges and tool resource limits remain source boundaries; the context layer does not clip the returned text again. [Cloud seam tests](../agent/cloud-context-seam.test.ts) cover full results, warnings and cancellation.

Entry point: [result-compressor.ts](result-compressor.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/compressor` when tests are present; `npm run lint`; `npm run docs:check`.
