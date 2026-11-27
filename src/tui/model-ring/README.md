# Favorite models

Status: current
Owner: src/tui/model-ring/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## What it does

A short list of favorite chat models (ATO-2169), at most nine, each `provider/model` (local models are `local-llama/<id>`; `provider:model`, the `run -m` spelling, is accepted too and shown with the slash, ATO-2773). `/model favorite` lists them, `/model favorite add` puts the current model in (or `add <provider/model>` another), `remove` takes one out, `clear` empties the list. Ctrl+P switches the next turn to the next favorite, wrapping, and a composer notice names it with its place (`Model: openai/gpt-5 (2/3)`); the composer's model control shows the new model as for any other switch. It stands down under Fusion, during a running turn, under the slash palette, a panel modal or a pending approval, and says why it cannot switch (no API key, not downloaded) instead of switching.

## Ownership and entry points

[model-ring.ts](model-ring.ts) is pure: parsing, the current entry from `TuiState`, the next entry. [model-ring-command.ts](model-ring-command.ts) parses `/model favorite`, imported by the slash parser. [model-ring-store.ts](model-ring-store.ts) keeps the list in `<stateDir>/model-favorites.json`: not config, no schema version; a missing or broken file is an empty list. [model-ring-actions.ts](model-ring-actions.ts) runs the command from [submit-handler](../submit-handler.ts) and the switch from [TuiApp](../tui-app.tsx) through the `onModelRingCycle` seam of [app-key-bindings](../app-key-bindings.ts). A cloud favorite goes through `onProvidersSelectChatModel` (the Cloud pane's Enter), a local one through `triggerLlmPrimary` on its Local pane row; nothing here writes config.

## Checks and limits

`npx vitest run src/tui/model-ring src/tui/menu/menu-registry.test.ts src/tui/session-rail/handle-session-pin-key.test.ts src/tui/tui-app.test.tsx`. Not yet: a status-bar badge for the ring position, a backward key, a `--models` launch flag, and sharing the list with the desktop picker (which keeps its own).
