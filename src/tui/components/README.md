# Shared UI primitives and shell composition

Status: current
Owner: src/tui/components/

Read inherited [TUI instructions](../AGENTS.md). This directory has two intentional roles. Feature presentation belongs to the [feature map](../README.md); it does not become generic by being an Ink component.

## Shared primitives

Generic pick-list/geometry, multi-line-editor and its body/clipboard/cursor/edits/input/keys/pointer helpers, chip, logo/art/types, fit-to-width, format-tokens, render-progress-bar and session-title text formatting consume data and callbacks. [Row windowing](../row-window.ts), shared input, mouse, context-menu, clipboard and theme have their own owners. LogoVariant/WordmarkPlacement are defined in [logo-types.ts](logo-types.ts); start-page layout consumes and re-exports those unchanged types.

The [import checker](../../../scripts/check-imports.mjs) rejects direct feature/domain imports, including type imports, from these named primitives, input/ and theme/. Shared theme must not import the chooser. Mouse/context-menu services deliberately retain global state/callback contracts; the gate does not claim transitive isolation of all UI infrastructure.

## Shell composition

Composer overlay/send/stop, prompt shell/meta bar and its row planning, provider-outage readout, queued messages, slash palette, hotkey hints/chips/row planning, sidebar, status bar, debug pane/diagnostics and terminal-too-small compose the app surface. They may connect feature views/selectors with global state/callbacks; they are not generic primitives. Sidebar combines session rail, navigation and scheduled tasks; status bar combines update/download readouts; debug pane chooses manage/observe panels; the composer joins context, coding-mode and provider selection.

[TuiApp](../tui-app.tsx), root state/actions/reducers/router/submit/layout and [ChatOrchestrator](../chat-orchestrator.ts) remain intentional composition points. The old context-usage facade remains unchanged. Existing composition tests stay near these owners even when they render multiple features. New feature views belong with their feature; new shared primitives require an explicit dependency review and checker registration.

## Checks

`npx vitest run src/tui/components/` covers editor, list adapter and shell suites; some tests deliberately exercise multiple owners (logo-fit, wizard-pick-list, manage-panel-fit). `npm run imports:check` and `npm run imports:self-test` verify the primitive boundary. Run app/input/layout seam tests for composition changes. No directory-depth or mandatory-barrel rule applies.
