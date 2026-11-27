# Rewind picker

Status: current
Owner: src/tui/rewind/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

`/rewind` (ATO-1057) lists the chat's earlier questions, newest first. Picking one asks what to take back (ATO-2467), like Claude Code's `/rewind`: **Chat and files**, **Chat only** or **Files only**, with the number of files that would be put back. The file choices are offered only when the agent's file tools changed something after that point that can still be put back; otherwise the box says so and offers the chat only. Files changed without a saved copy, older copies already dropped, and shell, git, archive, subagent or Fusion changes are noted under the choices: they stay as they are.

[rewind-picker.tsx](rewind-picker.tsx) owns the list and mouse selection, [rewind-choice.tsx](rewind-choice.tsx) the choice step; [rewind-picker-state.ts](rewind-picker-state.ts) owns open/cursor/close and routes the cursor to [rewind-choice-state.ts](rewind-choice-state.ts) once a point is picked; [rewind-messages.ts](rewind-messages.ts) words the notes and chat lines (file names, never paths or error text). Which rows are points and which cuts are refused belongs to [session-rewind](../../session/session-rewind.ts), the cut itself to [session-truncate](../../session/session-truncate.ts). The rewind (preview, files first then chat, forgetting the copies of removed turns) is [the runtime's shared rewind](../../runtime/session-rewind-service.ts), the same one the HTTP rewind routes call; the TUI never goes through HTTP.

Keys are the editor's, like the session picker's: [TuiApp](../tui-app.tsx) routes Up/Down and Esc, [submit-handler](../submit-handler.ts) handles Enter (on the list it asks for the choice, on a choice it hands it over; Enter while files are still being checked does nothing). [ChatOrchestrator](../chat-orchestrator.ts) `openRewindPicker` / `openRewindChoice` / `rewindTo` refuse while anything runs or is queued. A rewind that cuts the chat saves the cut session, rebuilds the transcript with `session_switched` and puts the question back in the composer; **Files only** leaves the chat as it is. A message sent while the rewind runs waits in the composer. A file that cannot be written back is named in the chat line and left as it is; the rest still go back. Questions inside a compaction checkpoint are not offered.

## Checks and limits

`npx vitest run src/runtime/session-rewind-service.test.ts src/session/session-rewind.test.ts src/tui/rewind src/tui/chat-orchestrator-rewind.test.ts src/tui/submit-handler.test.ts src/tui/commands src/tui/menu src/http/route-session-rewind.test.ts`. No renderer suite or manual terminal QA yet.
