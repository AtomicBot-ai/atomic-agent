# Favorite models

Status: current
Owner: src/tui/model-ring/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## What it does

A short list of favorite chat models (ATO-2169), at most twenty, each `provider/model` (local models are `local-llama/<id>`; `provider:model`, the `run -m` spelling, is accepted too and shown with the slash, ATO-2773). `/model favorite` lists them, `/model favorite add` puts the current model in (or `add <provider/model>` another), `remove` takes one out, `clear` empties the list. Ctrl+P switches the next turn to the next favorite, wrapping; alt+p and ctrl+shift+p switch to the previous one (ATO-2500). alt+p needs a terminal that sends Alt as Meta: Linux and Windows terminals do by default, but on a Mac Option+P types `π` in Terminal.app and iTerm2 until Option is set as Meta (Terminal.app: Settings > Profiles > Keyboard > Use Option as Meta key; iTerm2: Profiles > Keys > Left Option key: Esc+). ctrl+shift+p needs the kitty keyboard protocol (kitty, Ghostty, WezTerm, recent iTerm2 with it on); elsewhere it arrives as plain ctrl+p and walks forward. So a default Terminal.app has no back key, and ctrl+p wraps around instead. A composer notice names the new model with its place (`Model: openai/gpt-5 (2/3)`), and while the next turn runs on a favorite the composer bar says so after its readouts (` · fav 2/3`). It stands down under Fusion, during a running turn, under the slash palette, a panel modal or a pending approval, and says why it cannot switch (no API key, not downloaded) instead of switching. With vim on, alt+p stands down too: an Esc-prefixed `p` is vim's.

One list for both apps (ATO-2500): the desktop model picker's Favorites group reads and writes the same `<stateDir>/model-favorites.json` (the desktop moved its old per-window list into it once). The terminal reads the file again on every ctrl+p and `/model favorite`, so a star set in the desktop is there on the next press; the bar's `fav n/m` follows on that read.

`atomic-agent --models a/b,c/d` (or `atomic-agent tui --models ...`, pi's `--models`) gives this session its own ring, in that order, instead of the saved one. `/model favorite` then changes that session list and says it is not saved; the file is left alone.

## Ownership and entry points

[model-ring.ts](model-ring.ts) is pure: parsing (also of `--models`), the current entry from `TuiState`, the next or previous entry, the bar readout. [model-ring-keys.ts](model-ring-keys.ts) maps a key to a direction. [model-ring-command.ts](model-ring-command.ts) parses `/model favorite`, imported by the slash parser. [model-ring-store.ts](model-ring-store.ts) keeps the list in `<stateDir>/model-favorites.json`: not config, no schema version; a missing or broken file is an empty list. `TuiState.modelRing` holds the list as last read (action `model_ring_loaded`, emitted at startup by `tui-command.ts` and by every command and press) for [model-ring-readout.tsx](model-ring-readout.tsx), which `selectMetaBarFit` measures with the same label. [model-ring-actions.ts](model-ring-actions.ts) runs the command from [submit-handler](../submit-handler.ts) and the switch from [TuiApp](../tui-app.tsx) through the `onModelRingCycle(direction)` seam of [app-key-bindings](../app-key-bindings.ts). A cloud favorite goes through `onProvidersSelectChatModel` (the Cloud pane's Enter), a local one through `triggerLlmPrimary` on its Local pane row; nothing here writes config.

## Checks and limits

`npx vitest run src/tui/model-ring src/tui/tui-args.test.ts src/tui/tui-args.help.test.ts src/tui/menu/menu-registry.test.ts src/tui/session-rail/handle-session-pin-key.test.ts src/tui/tui-app.test.tsx`. The file is not watched: a star set in the desktop shows in the bar on the next ctrl+p or `/model favorite`, not the moment it is set. `--models` takes exact `provider/model` entries, not pi's glob patterns.
