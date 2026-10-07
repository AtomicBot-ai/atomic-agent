# Theme chooser

Status: current
Owner: src/tui/theme-picker/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[theme-picker.tsx](theme-picker.tsx) owns the modal list, swatches and mouse selection/activation. Shared palette definitions, proxy, contrast and colour math belong to [theme](../theme/theme.ts), which must remain independent of this chooser.

[TuiApp](../tui-app.tsx) owns live preview and original-theme restoration; [app-key-bindings](../app-key-bindings.ts) owns global modal precedence; [submit-handler](../submit-handler.ts) commits/persists the selection. Mouse activation uses that same submit path. Open/cursor/close state transitions remain in [reduce-ui-actions](../reduce-ui-actions.ts). Preserve Escape/backdrop revert, Enter commit and preview without persistence.

## Checks and limits

`npx vitest run src/tui/theme/ src/tui/submit-handler.test.ts src/tui/backdrop-dismissal.test.ts src/tui/reduce-ui-actions.test.ts src/tui/tui-app.test.tsx`. No dedicated ThemePicker renderer suite or manual terminal QA has been added. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
