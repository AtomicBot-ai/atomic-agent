# Composio integration

Status: current
Owner: src/composio/

Resolves hosted toolkits into an MCP server configuration/session. Keep provider credentials scoped and use the MCP client lifecycle rather than bypassing registry trust.

Entry point: [resolve-composio-server.ts](resolve-composio-server.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/composio` when tests are present; `npm run lint`; `npm run docs:check`.
