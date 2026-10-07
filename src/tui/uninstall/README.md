# Uninstall UI

Status: current
Owner: src/tui/uninstall/

This feature presents the removal plan and deliberate confirmation before handing off deletion after UI/runtime exit. Read [TUI instructions](../AGENTS.md), [uninstall domain guide](../../uninstall/README.md) and [runtime instructions](../../runtime/AGENTS.md) when changing the operation or resource ordering. The modal and input do not delete files.

## Presentation and transitions

[UninstallModal](uninstall-modal.tsx) renders loading, review, confirm, closing and failure. [State](uninstall-state.ts), [actions](uninstall-actions.ts) and [reducer](uninstall-reducer.ts) own the plan, typed word, Cancel/Continue cursor and guards. TuiApp composes the modal and its mouse callbacks; shared mouse/theme/fitToWidth retain their owners. Review begins on Cancel, and a click focuses its actual button before acting.

[Local keys](uninstall-key-bindings.ts) use only state/dispatch/callback from a type-only AppKeyContext dependency. [Global keys](../app-key-bindings.ts) retain modal precedence and delegate in the same place; [TuiApp](../tui-app.tsx) retains editor focus suppression. Enter on Continue needs a nonempty plan; the final step needs the separately typed confirmation word with current trim/case policy and capped input. No prefill/autocomplete or shortcut skips those transitions. Closing consumes keys; Ctrl+C on answerable steps closes and returns false through the existing route. Reducer ignores obsolete plan results after closing.

## Operations and ownership

[Orchestration](uninstall-orchestrator.ts) measures the domain plan and formats preview rows. Confirmation only flags the post-exit handoff and dispatches quit_requested. [tui-command](../tui-command.ts) unmounts the UI and awaits orchestrator/runtime shutdown before calling performUninstall. This prevents deletion while stores/server resources are still live. Domain [plan resolution](../../uninstall/resolve-uninstall-plan.ts) and [removal](../../uninstall/run-uninstall.ts) retain ownership of targets, platform paths and removal outcomes; view relocation changes none of them.

## Checks

Run `npx vitest run src/tui/uninstall src/tui/issue-report src/tui/uninstall-modal-focus.test.tsx src/tui/app-key-bindings.test.ts src/tui/app-key-bindings-selection.test.ts src/tui/tui-app.test.tsx src/uninstall src/error-reporting`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Use full `npm run test:ci` for acceptance. Verification must use disposable domain fixtures, not the operator's installation/state.

[Copy tests](uninstall-modal.test.tsx) exercise bodyLines, while [reducer](uninstall-reducer.test.ts) and [key tests](uninstall-keys.test.ts) cover confirmation/fall-through through the global router. Two [TuiApp focus tests](../uninstall-modal-focus.test.tsx) check that typing stays out of the composer and Escape does not open its menu. They remain beside the composition owner. Dedicated uninstall mouse tests and complete post-exit lifecycle coverage are absent; real uninstallation and manual terminal QA are not implied. Existing four local key-fixture cases and the root focus fixture's session-type case remain explicit debt.
