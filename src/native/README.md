# Native dependency loading

Status: current
Owner: src/native/

Loads externally shipped native/runtime dependencies. Preserve deployment fallback paths for better-sqlite3, playwright-core and @napi-rs/keyring. The keyring loader is synchronous and returns null instead of throwing, because the opt-in OS keychain must never break startup.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/native` when tests are present; `npm run lint`; `npm run docs:check`.
