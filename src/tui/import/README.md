# External-agent import UI

Status: current
Owner: src/tui/import/

This feature configures imports from other agents and displays preview/execution reports. Read [TUI instructions](../AGENTS.md), [domain import guide](../../import/README.md) and [runtime instructions](../../runtime/AGENTS.md); follow the affected config/session/memory/tasks/skills instructions for domain changes. External AGENTS.md in the Codex importer remains an input filename, not this repository's instruction guide.

## Presentation and input

[ImportPanel](import-panel.tsx) is composed by [DebugPane](../components/debug-pane.tsx). It renders configure, running, preview and done modes, notices and unreadable-store warnings. [Sources](import-sources.ts) and [form options](import-form-options.ts) define source-specific rows/options rather than silently honoring hidden toggles. Hermes/OpenClaw, Claude Code, Codex and Pi-family sources retain their existing option sets, overwrite and limit handling; secret import remains opt-in where offered.

[State](import-panel-state.ts), [actions](import-actions.ts), [reducer](import-reducer.ts) and [keys](import-key-bindings.ts) own form/focus and transitions. [Mouse adapter](import-mouse.tsx) focuses clicked rows and dispatches the same actions/callbacks as keyboard input, through the shared mouse registry. Running guards and panel precedence stay intact; the view introduces no independent import executor.

## Execution and ownership

[ImportOrchestrator](import-orchestrator.ts) routes tab preview/execute through [buildImportRunner](build-importer.ts), resolves options/limit and emits reports/failures. Preview uses execute=false; tab execution honors overwrite. It refreshes task/session projections only after the corresponding executed import. Its onboarding path deliberately writes with overwrite=false and no preview screen; [onboarding import](../onboarding/import-step.ts) remains the owner of that flow's selection.

Destination stores are already open and owned by runtime. The runner constructs domain importers and releases only its per-run source through close in existing finally blocks. Filesystem-only sources have a no-op close. shutdown has no timer or retained handle to release. Runner construction currently precedes the tab path's try/finally; this relocation does not change or establish error handling for failures before a runner exists. Domain conversion, conflict policies, credentials and storage remain outside the view.

## Checks

Run `npx vitest run src/tui/import src/tui/skills src/tui/onboarding/import-step.test.ts src/tui/onboarding/onboarding-import-flow.test.ts src/tui/onboarding/use-onboarding-lifecycle-import.test.tsx src/tui/app-key-bindings.test.ts src/tui/tui-app.test.tsx src/tui/components/debug-pane-budget.test.ts`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Use full `npm run test:ci` for acceptance.

[Panel tests](import-panel.test.tsx) and [mouse tests](import-panel-mouse.test.tsx) are adjacent; clicks use real Ink frames and MouseProvider/registry. Six other suites cover state, reducer, keys, options, sources and portions of orchestration, with onboarding seams elsewhere. Existing fixtures use disposable sources, not personal data. Passing them does not prove every source/secret conversion or manual terminal/platform behavior. Remaining feature test-type debt stays explicit.
