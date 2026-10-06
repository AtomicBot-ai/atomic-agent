# NDJSON sidecar

Status: current
Owner: src/sidecar/

Owns stdin/stdout transport and host event forwarding. Preserve protocol shapes, request/session ownership and the already-acquired turn lock seam.

Entry point: [main.ts](main.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/sidecar` when tests are present; `npm run lint`; `npm run docs:check`.
