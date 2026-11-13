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
- [turn-progress.ts](turn-progress.ts)

## Ownership and dependencies

SessionState holds turns, loaded descriptors and transient recalled context; SessionStore persists the chat and turn ownership. Retention owns bounded cleanup of eligible inactive sessions. Runtime controls execution and memory stores own durable facts, so a session snapshot must not be treated as either executor or memory database.

The optional version-1 [cloud context journal](cloud-context.ts) records the exact model-visible history and state updates in the existing session JSON. It has stable transcript-based call IDs, a processed transcript boundary and a boundary hash; old sessions initialize it on their first cloud build. Assembly extends it without mutation, runtime persists it before inference, and preview never commits. Current recalled inputs remain transient, but messages already shown to a cloud model remain journaled. Complete output increases stored session size; retention still applies to whole inactive sessions. Switching to local leaves the journal intact and uses the local projection; previously clipped local records cannot be reconstructed.

## Task-specific reading

Read README.md for state/retention changes; ../runtime/docs/lifecycle.md for concurrency and shutdown.

## Validation

`npx vitest run src/session`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Session compaction](session-compaction.ts) owns checkpoint validation and the shared history projection. The full transcript stays intact; semantic coverage and mechanical pack cuts have separate boundaries. Runtime owns [summarization and checkpoint persistence](../runtime/docs/compaction.md).

[Turn progress](turn-progress.ts) (ATO-1109): `executeTurn` marks a turn's progress when it starts and checkpoints the transcript with the marker after every completed step (`SessionStore.checkpointTurn`, one row write guarded on the turn's own mark). A turn that ends on its own clears the marker; one that ends `cancelled`, or whose process died (the boot sweep ends the row and keeps the marker), keeps it so the work can be continued. The task runner continues tasks cut off by a crash or a restart; nothing continues a turn a person stopped. A chat turn a restart cut off ([interrupted-chat-turn.ts](interrupted-chat-turn.ts), ATO-448) is never continued on its own: opening its session in the TUI shows a one-line offer, and `/resume` (`AgentRuntime.interruptedTurns`, the same entry point for the desktop or an HTTP client) sends one continuing turn, starting with a note that tools may or may not have completed and side effects must be checked before they are repeated. Taking it marks the turn "resume queued" in memory, so it is offered once; the continuing turn replaces the marker when it starts, and a resume dropped before that (queue cleared, run stopped, session switched) is offered again.

[Session titles](session-title.ts): the namer writes `metadata.title` once, after the first answered turn, and never renames. The operator can ([session-title-user.ts](session-title-user.ts), `SessionStore.renameSession`): that title carries `metadata.titleSetByUserAt`, and `save`/`finishTurn` keep it over any copy without the stamp or with an older one, so a stale snapshot cannot undo a rename.
