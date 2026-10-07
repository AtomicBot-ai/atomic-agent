# Stage 03f skills/import UI acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Slice 03f](../plans/03f-skills-import-ui.md) is verified; the whole [TUI stage](../plans/03-tui-organization.md) remains in progress. Current entries: [skills UI](../../src/tui/skills/README.md), [import UI](../../src/tui/import/README.md).

## Separate fixture fix and relocation

Before moving, import-panel-mouse.test.tsx lost one unused React import and gained the four required no-op TuiAppCallbacks: onApprovalDecision, onAbort, onQuit and onMessageSubmitted. Existing preview/execute collectors, click coordinates/actions, reports and assertions were preserved. Both component suites passed twelve tests. The type gate identified exactly two resolved cases, TS2739 and TS6133; its nonzero result requested ledger reduction rather than reporting a new error. reduce removed only these cases: 906 → 904. Compiler options/version and remaining fingerprint multiplicities are unchanged; no allowance was added or migrated.

The ledger's root/test path metadata was refreshed from pre-03e move names by reduce. Coverage remains 2366 roots and 105 test TSX; those path changes are inventory maintenance, not diagnostic migration. The 47 existing cases in skills/import feature tests remain explicit. Both moved component suites have no recorded debt.

Seven skills views moved from components to skills: panel, installed list/detail, hub list/card and install/remove confirmation. Import panel and its two component/mouse suites moved to import. Each group retargeted DebugPane; no other production view consumer needed a change. No forwarding modules, barrels or new dependencies were added.

Snapshots precede the fixture fix and each relocation group. Both groups passed exact byte comparison after recorded module-literal substitutions. The combined AST comparison covered all TS/TSX files and confirmed identical declarations/executable bodies to the post-fixture source snapshot except those paths. All assertions in both moved suites match their pre-fix snapshot. Protected operator review files retain their hashes.

Installation scan/stage/commit/discard, disable filtering, config writes, confirmation policy, import options/preview/execute, source conversion, runtime store ownership, callbacks, prompt literals and runtime bootstrap are unchanged. Guides locate views, state/input, orchestration and domain owners without copying their implementations into UI.

## Validation

- After each group: 18 selected files and 202 tests pass. This includes skills/import, real Ink import mouse targets, onboarding import seams, app keys/TuiApp and DebugPane budgeting.
- Full test:ci: 1041 files pass, 12436 tests pass, four existing platform/GC tests skip, exit 0. No tests were added or deleted. Existing HTTP/browser/daemon fixtures use authorized local loopback listeners.
- Production lint and test type gate pass; eleven type-checker self-tests pass. Final debt is 904 cases, with no new errors.
- imports:check: 1345 production modules, 4847 local edges, zero runtime cycles, zero exceptions. All 25 checker fixtures pass; rules are unchanged.
- docs:check passes links, metadata, pointers, archive coverage and instruction budgets; eleven self-tests pass. There are 19 instruction files, maximum chain 8093/24576 bytes.
- Quarantine/workflow registry validation passes with zero active exclusions and two released records. git diff --check passes.

## Limits and next slice

Skills has no dedicated component/orchestrator suites. Key/reducer/filter/summary tests cover portions of hub/card/confirmation state, not every rendered modal or live install/removal. shutdown starts discard for pending staged handles without awaiting all cleanup and does not add general network cancellation. Domain scan policy still commits clean installs immediately and uses the existing confirmation for other verdicts.

Import has real component/mouse suites and partial orchestration coverage, but no claim of every source/secret conversion or errors before runner construction. Destination stores remain runtime-owned; per-run source close remains in the existing finally. External AGENTS.md remains the Codex input format. No personal source or real registry install/delete/secret migration was used for verification.

Manual terminal/platform QA, hosted CI and the optional-canvas installation leg were not run. Package/lockfile versions, .pr-review-56/ and EVIDENCE_ROUTER_MODEL.md are unchanged. Remaining type debt stays explicit.

Inventory confirms privacy, integrations and swarm views already have local feature owners, so no mechanical flattening is implied for them. [Plan 03g](../plans/03g-issue-uninstall-ui.md) specifies issue-report/uninstall views and their currently embedded input handlers. Remaining shell/observation/update/theme ownership still needs classification before all of stage 03 can be accepted; no stage 04 plan is created yet.
