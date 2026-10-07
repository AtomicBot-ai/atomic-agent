# Session state and persistence

Status: current
Owner: src/session/

This area owns session state and persistence. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [session-state.ts](session-state.ts)
- [session-store.ts](session-store.ts)
- [conversation-turn.ts](conversation-turn.ts)
- [session-retention.ts](session-retention.ts)
- [turn-owner.ts](turn-owner.ts)

## Ownership and dependencies

SessionState holds turns, loaded descriptors and transient recalled context; SessionStore persists the chat and turn ownership. Retention owns bounded cleanup of eligible inactive sessions. Runtime controls execution and memory stores own durable facts, so a session snapshot must not be treated as either executor or memory database.

## Task-specific reading

Read README.md for state/retention changes; ../runtime/docs/lifecycle.md for concurrency and shutdown.

## Validation

`npx vitest run src/session`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Session compaction](session-compaction.ts) owns checkpoint validation and the shared history projection. The full transcript stays intact; semantic coverage and mechanical pack cuts have separate boundaries. Runtime owns [summarization and checkpoint persistence](../runtime/docs/compaction.md).
