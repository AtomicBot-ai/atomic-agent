# Integration registry

Status: current
Owner: src/integrations/

Owns integration descriptors, live settings and secret-resolution bridges. Keep channel/MCP ownership in their subsystems rather than duplicating lifecycle in the hub.

Entry point: [integration-registry.ts](integration-registry.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/integrations` when tests are present; `npm run lint`; `npm run docs:check`.
