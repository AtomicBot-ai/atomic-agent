# Stage 03b provider/LLM UI acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Slice 03b](../plans/03b-provider-ui.md) is verified; the whole [TUI organization stage](../plans/03-tui-organization.md) remains in progress.

## Changes and evidence of preserved behavior

Nine production modules and seven test modules moved from tui/components to their existing owners: provider panel/wizard/measurement/standalone onboarding to [providers](../../src/tui/providers/README.md), LLM panel/modals/mode rows to [llm-panel](../../src/tui/llm-panel/README.md), fallback rows to llm-panel/fallback, and badge/health mapping to [llm-health](../../src/tui/llm-health/README.md). No forwarding file or barrel was added. DebugPane, onboarding body/layout, composer controls, measured-panel test and modal-key test point to the new modules.

Before moving, five test files were corrected separately: four required callbacks were supplied in two fixtures, two unused React imports were removed, ProviderRow's required nullable subscriptionCli field was supplied, and a fetch spy's argument was typed from the fetch contract. All assertions remain. Inspection corrected an earlier plan diagnosis: subscriptionCli.cli is string; the actual error was an absent required subscriptionCli field, not a narrower CLI-name union.

The seven affected suites passed 70 tests before relocation. The type gate then reported exactly six resolved allowances and no new errors. reduce removed those six fingerprints; other fingerprints, multiplicity and compiler options are unchanged. One unrelated ledger navigation line was refreshed by reduction; line numbers do not authorize debt. Final typecheck:tests covers 2366 roots and 105 test TSX with 941 existing diagnostics, down from 947. The moved tests have no remaining recorded diagnostics; no debt fingerprint was migrated to a new path.

A source snapshot was taken both before fixture cleanup and before moves. Exact byte comparison after applying the recorded module-literal substitutions confirmed unchanged contents in all 16 moved files and six callers, including dynamic/mock/import-type targets. All other source files were byte-identical at that comparison. A subsequent comment in tui-app.test.tsx was redirected to the new LLM test location; it does not change execution. There are no production changes beyond module paths in this slice. Config versions/defaults, prompt literals, runtime bootstrap, SDK/transport operations and algorithms are unchanged.

Providers/LLM/health guides now locate view, state, input, orchestration, tests and cross-feature composition. The shared list/input remains independent. Onboarding intentionally composes the provider wizard/measurement; composer keeps the existing primary activation/preflight and imports health mapping from its owner. No dependency rule was weakened or exception added.

## Validation

- Before moves: 7 files, 70 tests pass.
- After moves: 69 focused files, 886 tests pass across providers, LLM/fallback, health, composer, onboarding and affected shared input/layout.
- Full test:ci: 1041 files pass, 12436 tests pass, 4 existing platform/GC tests skip, exit 0. No tests were added or deleted in this slice.
- Production lint and test type gate pass; 11 type-checker self-tests pass.
- imports:check: 1345 production modules, 4847 local edges, zero runtime cycles and zero exceptions; 25 checker self-tests pass.
- docs:check passes, including local targets, metadata, pointers, archive coverage and instruction budgets; 11 negative/positive self-tests pass. Instruction count remains 19; maximum chain is 8093/24576 bytes.
- Quarantine/workflow registry check passes with zero active exclusions and two released records. git diff --check passes.

The full run uses authorized local loopback listeners required by existing HTTP tests. Hosted CI and the optional-canvas matrix installation were not run locally. No package or lockfile version changed. Existing .pr-review-56/ and EVIDENCE_ROUTER_MODEL.md remain untouched.

## Limits and next slice

The 941 diagnostics elsewhere remain explicit debt. Real terminal/platform combinations, external provider services and a running local model were not manually exercised. Existing tests cover filtering, keyboard/mouse wizard activation, cancellation/probe/save, measured/modal layouts, live provider/fallback behavior, composer routes and health polling; this is not a claim of exhaustive visual coverage. There is no dedicated health-badge suite.

Standalone CloudProviderOnboarding still has no production consumer, but its API and tests remain. Wizard catalog fetch effects remain in views. Local-models UI and onboarding views still partly live in components/; subscription/lifecycle ownership was not broadened. After this acceptance, [plan 03c](../plans/03c-onboarding.md) specifies the next slice from the actual graph and debt. Stage 03 is not verified as a whole.
