# MCP client and tool catalog

Scope: `src/mcp/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep client lifecycle/catalog ownership in McpManager; detach dynamic tools on shutdown/restart. The SDK boundary is mcp-client and sampling type integration.
- Preserve trust-based resource classification and approval policy. Dynamic MCP schemas must be validated without assuming built-in schema restrictions.
- Sampling must use the documented isolated completion path and never take the user turn slot. Reject unsupported directions rather than silently implementing server behavior.
- Stdio clients currently inherit the agent environment plus per-server overrides; do not claim credential isolation. Never expose credentials in logs or error output. Any change to environment forwarding requires reviewing existing server compatibility.

## Read when relevant

Read docs/client.md before lifecycle, trust, sampling or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Checks

Run `npx vitest run src/mcp` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
