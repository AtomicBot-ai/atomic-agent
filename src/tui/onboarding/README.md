# First-run onboarding

Status: current
Owner: src/tui/onboarding/

This feature owns the first-run surface and its transition effects. Read [TUI instructions](../AGENTS.md), [config instructions](../../config/AGENTS.md) for persistence and the [local model guide](../../local-llm/README.md) for download/backend operations. [Import](../../import/README.md) owns importing external agent data; onboarding offers and displays that operation.

## Surface, transitions and input

[OnboardingScreen](onboarding-screen.tsx) owns the full first-run surface, placement and pinned footer; it exports OnboardingScreenCallbacks for the existing input/composition API. [Step body](onboarding-step-body.tsx) maps the current step to its view. [Surface layout](onboarding-surface-layout.ts) uses measurements beside each step's rendered strings and [centering](centre-onboarding-block.ts), while [fit](onboarding-fit.ts) supplies compact-terminal tiers. The screen composes [provider wizard](../providers/providers-wizard.tsx) and its measurement directly; the wizard remains provider-owned.

[State](onboarding-state.ts), [actions](onboarding-actions.ts), [reducer](onboarding-reducer.ts), [step keys](onboarding-step-keys.ts), [Hugging Face keys](onboarding-hf-keys.ts) and [input hook](use-onboarding-inputs.ts) define transitions and input precedence. [Intro input](use-intro-input.ts) shares dismissal across keyboard, mouse, wheel and paste. Mouse list activation uses the same key handlers; the shared terminal-size/editor/mouse/theme primitives retain their owners.

## Effects and resources

[Lifecycle](use-onboarding-lifecycle.ts) stamps shown/finished states and guards settlement/reporting. On finished it first decides the second-backend offer, then the import offer, then writes completion/skip and dismisses the surface; reruns suppress the first-run analytics reports. [Persistence](persist-onboarding-state.ts) merges only tui.onboarding through config validation, write and cache reset. The caller supplies timestamps. [Rerun](rerun-onboarding.ts) and tui-command reuse this helper; there is no new global state or domain persistence API.

[Hugging Face flow](onboarding-hf-flow.tsx) stays mounted before checking its render branch. [Its lookup hook](use-onboarding-huggingface.ts) owns an AbortController, cancellation/unmount cleanup and response identity guard; reducer step guards also drop responses after navigation. It reuses shared [reference editor](../local-models/hf-reference-editor.tsx) and [file list](../local-models/hf-pick-list.tsx) owned by [local-models UI](../local-models/README.md), using its own transitions.

[URL actions](use-onboarding-url-actions.ts) probe health/auth before advancing or persisting custom endpoints. These probes currently use timeouts and busy state without a dedicated AbortController or response identity guard; this reorganization preserves that behavior and does not establish URL cancellation safety. General backend readiness remains [shared TUI logic](../local-backend-readiness.ts), also used by commands.

[Download step](onboarding-download-step.tsx), [progress](onboarding-download-progress.tsx) and [wait/jump](onboarding-wait-or-jump-step.tsx) project local-models pull/error state. [Wait/jump selectors](wait-or-jump-selectors.ts) supply status/row count to both rendering and keys. LocalModelsOrchestrator/local-llm own the actual pull; leaving for chat does not transfer ownership or cancel the download. [Ambient view](onboarding-download-ambient.tsx) uses [atom hook](use-atom-field.ts), which owns its interval and cleanup. A failed/completed weights pull stops the animation; runtime-at-100% can still wait for weights. Resize updates bounds/population without changing the transition machine.

## Checks

Tests are beside their owners, including layout/mouse/download-frame seams and lifecycle/import effects. Run `npx vitest run src/tui/onboarding src/tui/providers src/tui/app-key-bindings.test.ts src/tui/tui-app.test.tsx` for transitions, cancellation, measurements, first-run completion, persistence and app composition. Existing HF tests exercise Escape cancellation and late results; there is no dedicated custom-URL action suite or direct interval-cleanup test at present. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`; full `npm run test:ci` checks integration. Use temporary state and injected import detection, not personal config/home data.
