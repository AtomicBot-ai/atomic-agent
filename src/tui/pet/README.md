# Terminal pet

Status: current
Owner: src/tui/pet/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## What it is

`/pet` (ATO-2513) puts a small ASCII face in the top bar that shows what the agent is doing: `thinking`, `using a tool`, `needs you` (an approval or a question is open), `done`, `failed`, `idle` and, after two quiet minutes, `resting`. Off by default; `/pet on|off` sets it and writes `tui.pet` in the user config. It is display only: it answers nothing and calls no model, approvals stay in the approval modal.

## Ownership and entry points

- [pet-machine.ts](pet-machine.ts): the state machine, the desktop pet's (`desktop/main/pet-state.ts`, ATO-2391) kept twice because the desktop build cannot import `src/`. [pet-machine.fixture.json](pet-machine.fixture.json) is the table of cases both suites replay, so the two cannot drift apart unseen.
- [pet-inputs.ts](pet-inputs.ts): what the machine reads from `TuiState` (status, the pending approval, tool calls in flight, the newest `runHistory` entry) and `PetTuiDriver`, one machine per chip.
- [pet-sprite.ts](pet-sprite.ts): the frames, plain ASCII so conhost and every font draw them; only active states move, so a resting pet never redraws the TUI.
- [pet-chip.tsx](pet-chip.tsx): the chip the [status bar](../components/status-bar.tsx) mounts while `TuiState.pet` is on.

`/pet` itself is the usual display switch: [slash dispatch](../commands/slash-command-handler.ts) returns `petVerb`, [submit-handler](../submit-handler.ts) flips `TuiState.pet` (`pet_set`) and asks `onPetPersistRequested` to write `tui.pet` ([persist-user-tui-config.ts](../persist-user-tui-config.ts)).

## Checks

`npx vitest run src/tui/pet src/tui/commands/slash-command-handler.test.ts src/tui/submit-handler.test.ts src/tui/reduce-ui-actions.test.ts src/config/tui-config.test.ts`, then `npm run lint` and `npm run docs:check`. Desktop side: `desktop/test/pet-fixture.test.mjs` replays the same fixture.
