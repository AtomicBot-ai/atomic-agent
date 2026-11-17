# Rewind picker

Status: current
Owner: src/tui/rewind/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

`/rewind` (ATO-1057) lists the chat's earlier questions, newest first, and takes the chat back to just before the one picked. [rewind-picker.tsx](rewind-picker.tsx) owns the list and mouse selection; [rewind-picker-state.ts](rewind-picker-state.ts) owns open/cursor/close. Which rows are points and which cuts are refused belongs to [session-rewind](../../session/session-rewind.ts), the cut itself to [session-truncate](../../session/session-truncate.ts).

Keys are the editor's, like the session picker's: [TuiApp](../tui-app.tsx) routes Up/Down and Esc, [submit-handler](../submit-handler.ts) handles Enter. [ChatOrchestrator](../chat-orchestrator.ts) `openRewindPicker` / `rewindTo` refuse while anything runs or is queued, save the cut session, rebuild the transcript with `session_switched` and put the question back in the composer. Only the conversation moves: there are no file checkpoints in the terminal, so files the agent changed stay as they are and the chat note says so. Questions inside a compaction checkpoint are not offered.

## Checks and limits

`npx vitest run src/session/session-rewind.test.ts src/tui/rewind src/tui/chat-orchestrator-rewind.test.ts src/tui/submit-handler.test.ts src/tui/commands src/tui/menu`. No renderer suite or manual terminal QA yet.
