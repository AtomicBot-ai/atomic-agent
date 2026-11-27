# Native dependency loading

Status: current
Owner: src/native/

Loads externally shipped native/runtime dependencies. Preserve deployment fallback paths for better-sqlite3, playwright-core, @napi-rs/keyring and @lydell/node-pty. The keyring and node-pty loaders are synchronous and return null instead of throwing: the opt-in OS keychain must never break startup, and an interactive shell job without the pty binding falls back to `script(1)` or plain pipes (ATO-2484).

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/native` when tests are present; `npm run lint`; `npm run docs:check`.
