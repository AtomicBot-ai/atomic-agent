# Prompt drift replay

Status: current
Owner: src/replay/

Compares the current stable prefix against recorded trace metadata. It does not simulate the external world or guarantee deterministic model output.

Entry point: [replay-session.ts](replay-session.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/replay` when tests are present; `npm run lint`; `npm run docs:check`.
