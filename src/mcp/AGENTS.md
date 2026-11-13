# MCP client and tool catalog

Scope: `src/mcp/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep client lifecycle/catalog ownership in McpManager; detach dynamic tools on shutdown/restart. The SDK boundary is mcp-client and sampling type integration.
- Preserve trust-based resource classification and approval policy. Dynamic MCP schemas must be validated without assuming built-in schema restrictions.
- Sampling must use the documented isolated completion path and never take the user turn slot. Reject unsupported directions rather than silently implementing server behavior.
- Elicitation never auto-accepts and never breaks the turn: `accept` only from the host's port, every failure is `decline` / `cancel`, answers never reach logs. Advertise the capability only when a port is wired. Wait by the port's surface: no cut-off for `interactive`, 5 minutes then decline for `remote-chat`, immediate decline for `none`; a pending elicitation holds the client's request deadlines.
- Stdio clients get only the allowlisted service variables (mcp-stdio-env.ts) plus their own configured `env`, never provider keys from `.env`. That is not a sandbox: a server can still read files the user can, so do not claim full credential isolation. Never expose credentials in logs or error output. Widening the allowlist needs a reason and must not admit credential-shaped names.

## Read when relevant

Read docs/client.md before lifecycle, trust, sampling, elicitation or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Checks

Run `npx vitest run src/mcp` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
