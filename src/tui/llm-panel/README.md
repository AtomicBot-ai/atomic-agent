# LLM selection panel

Status: current
Owner: src/tui/llm-panel/

This feature composes Local, Cloud, External and Fallback panes. Read [TUI instructions](../AGENTS.md) and the domain instructions for [LLM](../../llm/AGENTS.md), [config](../../config/AGENTS.md) and [local models](../../local-llm/AGENTS.md) when changing their operations.

## Presentation and transitions

[LlmPanel](llm-panel.tsx) owns the pane row budget, compact header and exclusive modal/detail/Hugging Face presentation. [Mode rows](llm-mode-rows.tsx) render selected rows, while [modals](llm-panel-modals.tsx) own modal composition, hasLlmModal and external URL parsing. [State](llm-panel-state.ts), [reducer](llm-panel-reducer.ts), [selectors](llm-panel-selectors.ts), [row builders](llm-panel-row-builders.ts), [keys](llm-panel-key-bindings.ts) and [modal keys](llm-panel-modal-key-bindings.ts) define the corresponding transitions and input precedence.

[Primary actions](llm-panel-primary-actions.ts) share activation/preflight with [composer controls](../composer-switch/composer-backend-control.tsx). That dependency deliberately keeps one switching path. Provider wizard presentation/verification belongs to [providers](../providers/README.md); local-model presentation/state/orchestration belongs to [local-models](../local-models/README.md), and downloads/server operations to the local-llm domain. Global TuiState/callbacks, DebugPane and TuiApp remain composition points.

## Fallback

[Fallback rows](fallback/llm-fallback-rows.tsx), [state](fallback/fallback-panel-state.ts), [reducer](fallback/fallback-panel-reducer.ts), [selectors](fallback/fallback-panel-selectors.ts), [keys](fallback/fallback-key-bindings.ts) and [orchestrator](fallback/fallback-orchestrator.ts) live together. The orchestrator persists through config commands and updates the live chain; display projects the effective chain and last switch rather than inventing a retry countdown. Provider defaults and runtime fallback policy remain domain contracts.

## Checks

Run `npx vitest run src/tui/llm-panel src/tui/providers src/tui/composer-switch` for measured layouts, modal precedence, cloud/external input, local actions, fallback and activation seams. Source and tests are adjacent. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`.
