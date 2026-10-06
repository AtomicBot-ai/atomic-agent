# Coding stance and plan handoff

Status: current
Owner: src/tui/coding-mode/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[coding-mode.ts](coding-mode.ts) owns UI mode mapping/cycling and presentation metadata. [coding-mode-chip.tsx](coding-mode-chip.tsx), [coding-mode-popup.tsx](coding-mode-popup.tsx) and [plan-handoff.tsx](plan-handoff.tsx) own the controls and execute-plan invitation. Approval policy itself remains with [approval](../../approval/README.md).

[TuiApp](../tui-app.tsx), [app-key-bindings](../app-key-bindings.ts), [submit-handler](../submit-handler.ts) and [reduce-ui-actions](../reduce-ui-actions.ts) retain global mode/input/state composition. Chat finalised messages compose the handoff; the chip composes into the prompt meta bar. Preserve default/plan/auto/bypass meaning, plan-to-execution transition, pending-turn guards and keyboard/mouse equivalence; moving UI must not change permissions.

## Checks and limits

`npx vitest run src/tui/coding-mode/ src/tui/coding-mode-menu.test.tsx src/tui/plan-handoff.test.tsx src/tui/plan-handoff-keys.test.tsx`. Composition suites stay beside the global app, with retargeted imports. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
