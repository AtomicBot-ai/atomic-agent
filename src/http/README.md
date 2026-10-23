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

[Compaction routes](route-compaction.ts) expose `POST /api/sessions/{id}/compact` and `GET /api/sessions/{id}/compaction`. The POST waits for runtime completion and cancels only its operation on disconnect. See [the shared contract](../runtime/docs/compaction.md). With `x-atomic-extensions: 1`, a chat stream also carries `compaction_started`, `compaction_progress`, `compaction_completed`, `compaction_failed` and `history_trimmed` frames ([mapping](stream-maintenance-frames.ts)): counts and statuses only.

[Rename route](route-session-title.ts): `PATCH /api/sessions/{id}` with `{ title }` (trimmed, 1-120 characters, one line; `400` otherwise, `404` for an unknown id) stores the operator's title through `SessionStore.renameSession`. The title is stamped as user-set, so the session namer never replaces it and a turn already running cannot write an older copy back over it.

`usage` on `/v1/chat/completions` (the body, the extensions-only `usage` frame) reports the tokens every LLM call of the turn reported, summed by the runtime's turn usage meter (`RunTurnResult.usage`; a local llama-server counts by its timings), and zeros when none did. A streaming request with `stream_options.include_usage: true` gets OpenAI's extra chunk before `data: [DONE]`: empty `choices` and the turn's `usage`; every chunk before it then carries `usage: null`, as OpenAI's do ([builders](openai-chunks.ts)).

[Approval route](route-approval.ts): `POST /api/approval/resolve` with `{ approvalId, decision }` takes `allow-once`, `deny` (aliases `approve`, `reject`) and `allow-in-chat`. `allow-in-chat` approves and records the gate's shape grant for the request's own session: later shell calls of the same binary (`commandShape`, `git`) in that chat run unasked (only calls that run that binary alone: a compound line such as `git status && …`, a pathed `./git`, a shell or a wrapper such as `env` has no shape and still asks), other binaries and other chats still ask, and nothing persists. A request without a shape gets `400` and stays pending. `GET /api/capabilities` lists the accepted decisions as `agent.approvalDecisions`; a client offers "allow in this chat" only when it is listed.
