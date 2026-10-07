# Application updates

Status: current
Owner: src/update/

Checks available release versions and coordinates update execution. A version comparison/check must not silently become installation.

Entry point: [check-app-update.ts](check-app-update.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/update` when tests are present; `npm run lint`; `npm run docs:check`.
