# Native dependency loading

Status: current
Owner: src/native/

Loads externally shipped native/runtime dependencies. Preserve deployment fallback paths for better-sqlite3 and playwright-core.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/native` when tests are present; `npm run lint`; `npm run docs:check`.
