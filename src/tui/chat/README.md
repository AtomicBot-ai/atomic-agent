# Chat transcript and start page

Status: current
Owner: src/tui/chat/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[chat-log.tsx](chat-log.tsx) composes finalised messages, streaming output and the empty-chat splash. Bubbles/tool cards, copy/link/retry/switch-back/fallback buttons, the `[copy path]` chip on finished read/write/edit cards ([tool-card-path-chip.tsx](tool-card-path-chip.tsx); copies, never opens), the stale-read note a collapsed card keeps on its own unclipped row, height measurement and splash fitting belong here. [turns-to-messages.ts](turns-to-messages.ts) projects persisted turns; [format-agent-error-for-chat.ts](format-agent-error-for-chat.ts) formats failures without changing agent policy. waiting-phrases.ts retains its existing exports.

A finished turn folds its reasoning and tool cards into one line that says what was done, `Read 3 files, ran 2 commands · 1 failed · 40s ▸` ([turn-fold-line.tsx](turn-fold-line.tsx), logic in [render/turn-collapse.ts](../render/turn-collapse.ts); the words come from `describeToolCalls` in [tools/describe-tool-call.ts](../../tools/describe-tool-call.ts), and `Used 6 tools` is the fallback when it has nothing to say). A click on it or `/expand` opens it (`/expand all` opens every turn and card, `/collapse` folds them back); an opened turn shows a card's result line only when the call failed. `tui.showSteps` (`/steps on|off`) keeps every finished turn open, as before. The running turn and its progress notes never fold.

`/verbose` (ATO-34) adds one plain note under every finished tool card: the step number, the call with its args, and what came back ([step-note.ts](step-note.ts)). It lives for this TUI run only. `/why` prints the last step in plain words, plus the last model call's tokens and the model's reasoning when it gave any ([why-snapshot-tui.ts](../why-snapshot-tui.ts)).

ChatMessage, pending output, tool expansion, turn marks and active-session attribution remain in [TuiState](../tui-state.ts) and [agent-event-reducer](../agent-event-reducer.ts). [ChatOrchestrator](../chat-orchestrator.ts) is the whole TUI runtime/session coordinator despite its name: switching, replay, detached turns, approvals, cancellation and feature orchestrators remain there. [TuiApp](../tui-app.tsx) composes chat with editor, panels and menus. Do not move runtime resources into bubbles.

[thinking-indicator.tsx](thinking-indicator.tsx) also renders queued/running context compaction independently of the agent's turn status. A running summary shows its own elapsed time, current/planned part, completed parts and estimated raw source size (separate from rendered history tokens); progress within a model call is not guessed. Per-session activity survives switching chats and is removed on completion, failure, cancellation or a request that needs no reduction.

Plan handoff composes [coding mode](../coding-mode/README.md); shared logo and its types stay in [components](../components/README.md). Links/copy use shared mouse/clipboard services. Preserve one rendered terminal reply, tool-result ordering, worker attribution, finalisation, retries and narrow-terminal splash fitting.

## Checks and limits

`npx vitest run src/tui/chat/ src/tui/agent-event-reducer.test.ts src/tui/chat-loop-reducer.test.ts` plus affected chat-orchestrator suites. Existing adjacent tests cover message projection, errors, bubbles, buttons, sizing and splash. The configure-fallback suite checks action constants/label; it does not prove a real click. Daemon restart composition tests require local port listeners. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
