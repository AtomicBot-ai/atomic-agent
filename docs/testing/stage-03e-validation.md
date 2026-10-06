# Stage 03e memory/tasks UI acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Slice 03e](../plans/03e-memory-tasks-ui.md) is verified; the whole [TUI stage](../plans/03-tui-organization.md) remains in progress. Current entries: [memory UI](../../src/tui/memory/README.md), [tasks UI](../../src/tui/tasks/README.md).

## Separate fixture fixes and mechanical moves

Two reducer fixtures now build complete TuiSessionInfo values with fakeSession, preserving every previously explicit field/value. A composite memory test state is annotated as TuiState. Each test file binds the original reducer function to a typed TuiAction signature; no wrapper, cast or production signature change is involved. This checks real action payloads while preserving the reducers' broad fall-through API. Assertions, events and payloads remain unchanged.

Before moves, eight memory/tasks files passed 68 tests. The type gate resolved exactly sixteen cases, not sixteen fingerprint records: five in memory-reducer.test and eleven in tasks-reducer.test, including repeated action-object fingerprints. reduce removed only these cases, 922 → 906; remaining fingerprints/multiplicities and compiler options/version are unchanged. Coverage remains 2366 roots and 105 test TSX. The ledger's root/test path metadata was refreshed from its pre-03d move names by reduce; that path inventory change did not introduce or migrate any diagnostic allowance.

Three production views moved from components to memory: panel, list and detail. Six moved to tasks: panel, list, detail, filter bar, create form and cancel modal. No tests needed relocation. DebugPane now imports both feature panels; TuiApp still renders task cancellation separately above the editor. The existing focusAfter export remains in the create view, and tasks keys now import it locally. No forwarding modules or barrels were added.

Snapshots were saved before fixture fixes and before each move group. Memory (three moves, one caller) and tasks (six moves, three callers) each passed exact byte comparison after recorded module-literal substitutions. The final combined AST comparison covered every TS/TSX source file: declarations/executable bodies are identical to the post-fixture snapshot except module paths. All assertion expressions in the two corrected fixtures remain identical to their pre-fix snapshot. Protected operator review files match their starting hashes.

Production reducers, callbacks, input precedence, refresh cadence, store reads, runner operations, cancellation, config defaults/versions, prompt literals and runtime bootstrap remain unchanged. The two new feature guides and parent/interface/dependency navigation name current owners and coverage limits.

## Validation

- After each move group: 12 selected files and 148 tests pass, including memory/tasks pure suites, app keys/selection, TuiApp and DebugPane budget tests.
- Full test:ci: 1041 files pass, 12436 tests pass, four existing platform/GC tests skip, exit 0. No tests were added or deleted. Existing HTTP/browser/daemon fixtures use authorized local loopback listeners.
- Production lint and test type gate pass; eleven type-checker self-tests pass. Final debt is 906 cases, with no new errors.
- imports:check: 1345 production modules, 4847 local edges, zero runtime cycles, zero exceptions. All 25 checker fixtures pass; ownership rules are unchanged.
- docs:check passes local links, metadata, pointers, archive coverage and instruction budgets; eleven self-tests pass. There are 19 instruction files, maximum chain 8093/24576 bytes.
- Quarantine/workflow registry check passes with zero active exclusions and two released records. git diff --check passes.

## Limits and next slice

TasksList retains its own cursor window and fixed padded/truncated columns; maxRows limits its row slice rather than the entire rendered panel. The separately tested tasks-list-fit helper is not wired into that view. Passing those helper tests is not evidence that the actual table fits all terminals. No layout algorithm was corrected during relocation.

Memory/task component and orchestrator suites are absent; tasks also has no dedicated key-binding suite. Existing reducer/filter/validation tests and portions of app composition do not prove live store/runner effects, all timer/subscription lifetimes, or every modal/form/mouse interaction. Memory shutdown clears its timer without new subscription disposal; task firings remain a UI projection of observed records rather than a complete durable log. These limits are documented, not silently refactored.

Real scheduled execution, external services and manual terminal/platform QA were not exercised. Hosted CI and the optional-canvas installation leg were not run locally. Package/lockfile versions and .pr-review-56/ and EVIDENCE_ROUTER_MODEL.md are unchanged. Remaining test-type debt stays explicit.

After acceptance, [plan 03f](../plans/03f-skills-import-ui.md) specifies skills/import presentation. Other feature and shell views still remain in components; stage 03 is not complete and no stage 04 plan is created yet.
