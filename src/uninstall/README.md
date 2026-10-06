# Uninstallation

Status: current
Owner: src/uninstall/

Resolves explicit uninstall targets before destructive removal. Preserve platform path handling and user-state choices.

Entry point: [resolve-uninstall-plan.ts](resolve-uninstall-plan.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/uninstall` when tests are present; `npm run lint`; `npm run docs:check`.
