# HTTP and OpenAI-compatible ingress

Status: current
Owner: src/http/

This area owns http and openai-compatible ingress. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [http-server.ts](http-server.ts)
- [route-sessions.ts](route-sessions.ts)
- [route-mcp.ts](route-mcp.ts)
- [request-context.ts](request-context.ts)
- [openai-completions-cancel.ts](openai-completions-cancel.ts)

## Ownership and dependencies

The HTTP server owns request handling and connection cancellation; route modules translate transport payloads into runtime operations. Session routes use the existing turn/steering contract, and webhook routes materialize durable tasks. Runtime owns session execution, task storage and approval policy; routes must retain authentication and error mapping. MCP routes use [shared server-config commands](../config/mcp-server-commands.ts) and manager operations, independently of TUI.

## Task-specific reading

Read README.md and ../runtime/docs/lifecycle.md for session/stream/steering changes.

## Validation

`npx vitest run src/http`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Compaction routes](route-compaction.ts) expose `POST /api/sessions/{id}/compact` and `GET /api/sessions/{id}/compaction`. The POST waits for runtime completion and cancels only its operation on disconnect. See [the shared contract](../runtime/docs/compaction.md).

Skills and capabilities accept optional `sessionId` for the selected cloud
workspace. `workspace=true` without an ID previews a new, unsaved session in
the server's startup directory; it accepts no client filesystem path. Calls
without either query retain the legacy registry. Cloud skill lists include
disabled reasons, source paths and a content fingerprint for refreshing open
details. These are operator views; disabled entries are excluded from model
capabilities and dispatch still enforces the current policy.
