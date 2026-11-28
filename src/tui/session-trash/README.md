# Chats in Trash

Status: current
Owner: src/tui/session-trash/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

A chat moved to Trash (the desktop's Delete, or `POST /api/sessions/{id}/trashed`; `metadata.trashed`, [session-trashed](../../session/session-trashed.ts)) is off the rail, the session picker and search, as a deleted chat would be (ATO-2474). [session-trash-command.ts](session-trash-command.ts) is the terminal's way to see and restore them: `/sessions --deleted` (or `--trash`) writes a numbered list in the chat, newest move first; `/sessions --restore <number or id>` clears the flag through `SessionStore.setSessionTrashed` and [ChatOrchestrator](../chat-orchestrator.ts) `sessionsTrash` refreshes the rail. The list comes from `SessionStore.listTrashed` ([session-trash-list](../../session/session-trash-list.ts)). The precedent is Gemini CLI's `/chat list` and `/chat resume <tag>`.

## Checks and limits

`npx vitest run src/tui/session-trash src/session/session-trash-list.test.ts`. The terminal never deletes a chat in Trash: the desktop deletes it for good after 30 days (`desktop/main/chat-trash.ts`), and Delete in the terminal's rail still deletes a chat at once.
