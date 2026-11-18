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
- [session-search.ts](session-search.ts)
- [chat-export/](chat-export/index.ts): one chat as a redacted HTML or Markdown file for `atomic-agent share` (ATO-581)

## Ownership and dependencies

SessionState holds turns, loaded descriptors and transient recalled context; SessionStore persists the chat and turn ownership. Retention owns bounded cleanup of eligible inactive sessions. Runtime controls execution and memory stores own durable facts, so a session snapshot must not be treated as either executor or memory database.

The optional version-1 [cloud context journal](cloud-context.ts) records the exact model-visible history and state updates in the existing session JSON. It has stable transcript-based call IDs, a processed transcript boundary and a boundary hash; old sessions initialize it on their first cloud build. Assembly extends it without mutation, runtime persists it before inference, and preview never commits. Current recalled inputs remain transient, but messages already shown to a cloud model remain journaled. Complete output increases stored session size; retention still applies to whole inactive sessions. Switching to local leaves the journal intact and uses the local projection; previously clipped local records cannot be reconstructed.

[Search over past chats](session-search.ts) (ATO-1149) is an FTS5 index of the chat lines `listChatLines` reads, in the same file. It is filled at search time, not on writes: each search reads changed transcripts without the write lock and writes them 25 sessions per transaction, up to 500 per search. Every channel is indexed with a `source` label and task sessions rank lower; incognito chats, Fusion workers and sessions stamped `metadata.internal` / `metadata.subagent` are never indexed (`classifySessionForSearch`).

## Task-specific reading

Read README.md for state/retention changes; ../runtime/docs/lifecycle.md for concurrency and shutdown.

## Validation

`npx vitest run src/session`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Session compaction](session-compaction.ts) owns checkpoint validation and the shared history projection. The full transcript stays intact; semantic coverage and mechanical pack cuts have separate boundaries. Runtime owns [summarization and checkpoint persistence](../runtime/docs/compaction.md).

[Turn progress](turn-progress.ts) (ATO-1109): `executeTurn` marks a turn's progress when it starts and checkpoints the transcript with the marker after every completed step (`SessionStore.checkpointTurn`, one row write guarded on the turn's own mark). A turn that ends on its own clears the marker; one that ends `cancelled`, or whose process died (the boot sweep ends the row and keeps the marker), keeps it so the work can be continued. The task runner continues tasks cut off by a crash or a restart; nothing continues a turn a person stopped. A chat turn a restart cut off ([interrupted-chat-turn.ts](interrupted-chat-turn.ts), ATO-448) is never continued on its own: opening its session in the TUI shows a one-line offer, and `/resume` (`AgentRuntime.interruptedTurns`, the same entry point for the desktop or an HTTP client) sends one continuing turn, starting with a note that tools may or may not have completed and side effects must be checked before they are repeated. Taking it marks the turn "resume queued" in memory, so it is offered once; the continuing turn replaces the marker when it starts, and a resume dropped before that (queue cleared, run stopped, session switched) is offered again.

[Chat export](chat-export.ts) (ATO-1054): one chat as Markdown (messages, replies, one line per tool step, delivered files; no reasoning or raw tool output), and HTML ([renderChatHtml](chat-export.ts), raw HTML shown as text, CSP blocks loads) or DOCX ([chat-export-docx.ts](chat-export-docx.ts), minimal OOXML zipped with JSZip) built from that Markdown. Used by `atomic-agent export` and `GET /api/sessions/{id}/export`.

[Archived chats](session-archived.ts) (ATO-1150): `metadata.archived: true` marks a chat the operator put away, with `metadata.archivedSetAt` stamping every archive and unarchive. `SessionStore.setSessionArchived` sets it; `save`, `finishTurn` and `checkpointTurn` keep the stored flag over a copy with no stamp or an older one, as for a renamed title. `SessionSummary.archived` carries it to the lists. Not the turn archive (`turn-archive.ts`), which is storage for compacted turns.

[Session titles](session-title.ts): the namer writes `metadata.title` once, after the first answered turn, and never renames. The operator can ([session-title-user.ts](session-title-user.ts), `SessionStore.renameSession`): that title carries `metadata.titleSetByUserAt`, and `save`/`finishTurn` keep it over any copy without the stamp or with an older one, so a stale snapshot cannot undo a rename.

[Dataset export](dataset-export/export-dataset.ts) (ATO-1104) backs `atag data export-dataset`: it pages through the session list newest first, turns each chat's `listChatLines` into one chat fine-tuning record (user messages and closing answers only, see [build-dataset-record.ts](dataset-export/build-dataset-record.ts)) and scrubs every message with [scrub-dataset-text.ts](dataset-export/scrub-dataset-text.ts): the shared credential detector, the looser report shapes, emails and home folders, each counted. It only reads the store and writes one local file.

[Next-step suggestion](session-next-step.ts) (ATO-1093): with `tui.nextStepSuggestions` on (ATO-1096, default off), one side call of at most 40 output tokens after each answered turn writes `metadata.nextStep` `{ text, afterTurn, at }`; `readSessionNextStep` shows it only while `afterTurn` equals `turnCount` and no turn is running. Fired from the runtime like the namer ([runtime-next-step.ts](../runtime/composition/runtime-next-step.ts)): never awaited, never after a budget stop, not for scheduler or fusion turns. A separate, smaller model can write it instead of the chat model ([next-step-endpoint.ts](next-step-endpoint.ts), ATO-1097): set `ATOMIC_AGENT_NEXT_STEP_URL` to any OpenAI-compatible server (a second llama-server, LM Studio, Ollama), optionally `ATOMIC_AGENT_NEXT_STEP_MODEL` and `ATOMIC_AGENT_NEXT_STEP_API_KEY`; the chat model's side-call slot then stays free. A failing separate model gives no suggestion, it never falls back to the chat model.

[Session worktrees](session-worktree.ts) (ATO-576, `/new worktree`): opt-in, git repos only. The session gets its own worktree and branch under `<stateDir>/worktrees`; the binding is `SessionState.worktree`. [Cleanup](session-worktree-cleanup.ts) removes only idle, merged, clean worktrees, never with `--force`; an ignored file such as `.env` keeps the worktree, only caches like `node_modules` do not.


[Session project](session-project.ts) (ATO-42): a client's project (the desktop groups chats into projects with shared instructions) is owned by the client. Its instructions arrive with each turn (`project_instructions`, `project_name` on `POST /v1/chat/completions`) and `runTurn` stamps them on the session's `metadata.project` inside the turn lock; null clears them, an absent field keeps them. The prompt renders them like a folder's AGENTS.md: a `project` cloud context section and a capped `### project` block ahead of the local conversation.

[Incognito chats](incognito.ts) (ATO-586): `incognito` on the state, fixed at creation (`run --incognito`, TUI `/incognito`, HTTP `incognito: true` on a new chat). No memory is written from one, no list or search shows it, and it is deleted with its archived turns and trace when closed, or at the next boot once its owning process is gone (`SessionStore.sweepOrphanIncognito`), with the tasks bound to it (ATO-1547).
