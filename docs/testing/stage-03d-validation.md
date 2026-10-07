# Stage 03d local-models UI acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Slice 03d](../plans/03d-local-models-ui.md) is verified; the whole [TUI organization stage](../plans/03-tui-organization.md) remains in progress. [The local-models guide](../../src/tui/local-models/README.md) is the current entry.

## Owners and separate changes

Seven production modules and two test modules moved from components to local-models: panel/detail, HF branch, shared HF reference editor/pick list, notification prompt, download chip and log panel. The original six-view plan missed local-llm-logs-panel; the full inventory found its state/reducer/polling already under local-models, so this seventh mechanical move was explained and added to the plan before relocation. DebugPane, LLM panel/modals, StatusBar, onboarding HF steps and measured-panel tests now import their owners. No forwarding module or barrel was added.

HF editor/list remain callback-driven specialized presentation shared with onboarding. They do not import onboarding or its key table. Their local-llm repo types/RAM policy remain explicit rather than being relabeled generic primitives. Shared editor/transfer-rate/mouse/theme/row-window/progress helpers, backend readiness and multi-flow config helpers retain their owners. Domain download/server/catalog algorithms remain untouched.

Before moving, two unused React imports were removed and LONG_ID was annotated as the actual LocalModelId contract. Its expression, custom prefix, padEnd and 87-character value are unchanged, as are all assertions. The two suites passed thirteen tests. The type gate reported exactly five resolved diagnostic cases: two TS6133 and one TS2322 fingerprint with count=3. reduce removed only these allowances; compiler options, remaining fingerprints and multiplicity are unchanged. Final typecheck:tests covers 2366 roots, 105 test TSX and 922 existing diagnostics, down from 927. Moved tests have no remaining recorded debt; no diagnostic was migrated to a new path. The 24 cases in existing local-models tests remain.

Snapshots were saved before fixture fixes and before each group of moves. The panel/HF group (four files, five callers) and status/notification/log group (five files, four callers) each passed exact byte comparison after recorded module-literal substitutions. A final combined AST comparison confirmed identical declarations/executable bodies across all nine moves and every other TS/TSX source file after accounting for import paths/comments. Dynamic/mock/type-import targets are included. All assertion expressions in the two corrected fixtures remain identical. Protected operator review files match their starting hashes.

One source comment now names the existing local-models-hf-branch instead of the nonexistent local-models-hf-panel; execution is unchanged. Config defaults/versions, prompt literals, runtime bootstrap, callbacks, SDK operations, process ownership and orchestration algorithms are unchanged. Navigation explains view/state/input, live operations and real resource owners.

## Validation

- Before moves: two files, thirteen tests pass.
- After panel/HF moves, the first default-sandbox run failed three daemon-wedge-watch cases with EPERM on listen(127.0.0.1); 794 tests passed. This was a failed run, not an accepted result. No source change was made to bypass it.
- Repeating the same focused set with authorized local loopback listeners passed all 78 files and 797 tests, exit 0.
- After the second group, the focused set including provider seams passed 99 files and 1090 tests, exit 0.
- Full test:ci: 1041 files pass, 12436 tests pass, four existing platform/GC tests skip, exit 0. No tests were added or deleted.
- Production lint and test type gate pass; eleven type-checker self-tests pass.
- imports:check: 1345 production modules, 4847 local edges, zero runtime cycles, zero exceptions. All 25 checker self-tests pass; no ownership rule was weakened.
- docs:check passes for links/metadata/pointers/archive coverage and instruction budgets; eleven self-tests pass. There are still 19 instruction files, maximum chain 8093/24576 bytes.
- Quarantine/workflow registry validation passes with zero active exclusions and two released records. git diff --check passes.

The full run uses authorized local listeners required by existing HTTP/browser/daemon fixtures. Hosted CI and the separate optional-canvas installation leg were not run locally. Package/lockfile versions and protected .pr-review-56/ and EVIDENCE_ROUTER_MODEL.md are unchanged.

## Limits and next slice

The 922 diagnostic cases elsewhere remain explicit debt. Real terminals/platform combinations, provider/HF services and actual model downloads/server operation were not manually exercised. Existing measured-panel, LLM local keys/app, onboarding HF/mouse, notification/chip/status-bar, reducer and orchestration suites cover portions of composition; there are still no individual local-panel/HF-branch/log component suites. Moving these files does not establish exhaustive visual or request-lifetime coverage.

Local HF explicit cancellation/identity guards, shutdown/download-watch/daemon policy and log polling are preserved, not refactored. Other panel and chat/shell views still remain in components. After acceptance, [plan 03e](../plans/03e-memory-tasks-ui.md) specifies memory/tasks presentation and their existing reducer-fixture debt. Stage 03 is not complete; no stage 04 plan is created yet.
