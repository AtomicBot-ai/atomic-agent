# Stage 03c onboarding acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Slice 03c](../plans/03c-onboarding.md) is verified; the whole [TUI organization stage](../plans/03-tui-organization.md) remains in progress. [Onboarding's guide](../../src/tui/onboarding/README.md) is the current entry.

## Owners and separate changes

Onboarding's 18 view/measurement source modules and 14 view/seam tests moved from components to onboarding. Its five specific hooks and two lifecycle tests moved from hooks, and timestamp persistence plus its test moved from the TUI root. Total: 24 production modules and 17 test modules, with no forwarding files or barrel. TuiApp, TUI commands, input, rerun and test consumers point to their owners. General terminal-size/transfer-rate/editor/mouse/theme primitives and backend readiness remain shared; provider wizard, local-models downloads and import operations retain their owners.

Before any move, eleven fixture files were corrected separately: eleven unused React bindings and one unused ROOT_PADDING_LEFT import were removed, the mouse fixture gained four required callbacks, and completed-download state was annotated as TuiState to contextually validate its modelId. Named React imports, model values, assertions and behavior remain. Seventeen affected files passed 155 tests. The type gate confirmed exactly fourteen resolved diagnostics and no new errors, then reduce removed only those allowances; compiler settings, other fingerprints and multiplicities are unchanged. Final debt is 927, down from 941. No diagnostic was migrated to a new test path and the moved tests have no remaining recorded debt.

Snapshots were saved before fixture cleanup, before view moves and before effect moves. View relocation was checked separately: 32 moves and four callers were byte-identical after recorded module-literal substitutions. Effect relocation: nine moves and seven callers passed the same comparison. The final combined comparison confirmed identical TS/TSX declarations and executable bodies across all 41 moves and every other source file after accounting for module addresses and comments. This includes mock/dynamic/type-import paths. All assertion expressions in the eleven corrected fixtures remain identical. Protected review files were checked against their starting hashes and remain unchanged.

Two source comments were corrected independently: HF flow no longer cites an obsolete 300-line budget, and URL actions no longer claim they are onboarding's only async effects. These change no execution. Prompt literals, config versions/defaults, runtime bootstrap, callbacks and SDK/download/daemon/import algorithms are unchanged.

## Behavior and validation

The surface still composes its steps, measured layout and ambient drawing. Keyboard/mouse share handlers. Lifecycle still resolves second-backend offer, then import offer, then completion/skip stamps and dismissal; report/settlement guards and rerun suppression remain. HF lookup keeps abort/unmount cleanup, response identity and reducer step guards. Local-models owns continuing downloads; jumping to chat does not cancel them. Timestamp persistence keeps read/merge/validate/write/reset ordering with caller-provided timestamps.

- Before moves: 17 files, 155 tests pass.
- After view moves: 62 files, 793 tests pass across onboarding, lifecycle/persistence, providers, app keys and TuiApp.
- After effect moves: the same 62 files and 793 tests pass at their new paths.
- Full test:ci: 1041 files pass, 12436 tests pass, 4 existing platform/GC tests skip, exit 0. No tests were added or deleted.
- Production lint and typecheck:tests pass: 2366 roots, 105 test TSX, 927 explicit debt diagnostics, no new errors. Eleven type-checker self-tests pass.
- imports:check: 1345 modules, 4847 local edges, zero runtime cycles, zero exceptions; 25 checker self-tests pass.
- docs:check passes for links/metadata/pointers/archive coverage and budgets; 11 self-tests pass. Instruction count remains 19; maximum chain is 8093/24576 bytes.
- Quarantine/workflow registry validation passes with zero active exclusions and two released records; git diff --check passes.

The full run uses authorized local loopback listeners for existing HTTP tests. Hosted CI and the optional-canvas installation leg were not run locally. Package/lockfile versions and protected operator review files remain unchanged.

## Limits and next slice

The remaining 927 diagnostics are explicit debt, not a claim that all tests are type-correct. Real terminals/platform combinations, external provider/HF services and actual model downloads were not manually exercised. Existing HF tests prove Escape cancellation and late-response suppression; existing ambient tests cover animation/failure/completion/resize, but there is no direct interval-cleanup test.

Inspection clarified the URL branch: it uses health/auth timeouts and busy state, without a dedicated AbortController or response identity guard. Its lifecycle safety was not fixed by relocation, and there is no dedicated custom-URL action suite. This limitation is recorded in the feature guide; the plan's broad phrase about URL/HF cancellation must not be read as proof of URL cancellation. The production behavior stays unchanged.

Local-models UI and the other panels still partly live in components. After this acceptance, [plan 03d](../plans/03d-local-models-ui.md) specifies six remaining local-model presentation modules, shared HF composition and two tests. Stage 03 remains in progress; stage 04 on local-llm/tools is not started.
