# Stage 03g issue-report/uninstall UI acceptance evidence

Status: current
Owner: repository maintainers

Recorded 2026-10-06. [Slice 03g](../plans/03g-issue-uninstall-ui.md) is verified; the whole [TUI stage](../plans/03-tui-organization.md) remains in progress. Current entries: [issue-report](../../src/tui/issue-report/README.md), [uninstall UI](../../src/tui/uninstall/README.md).

## Mechanical relocation and separate input extraction

IssueReportPopup moved from components to issue-report, where its existing component suite already lives. UninstallModal and its bodyLines/copy suite moved to uninstall. TuiApp and the issue-report component test retargeted imports. Three moves and two callers passed exact byte comparison after recorded module-literal substitutions; no forwarding module or barrel was added.

The two private functions handleIssueReportKey and handleUninstallKey were then extracted from app-key-bindings into their feature's key-bindings module. Bodies, argument order, return types and invariant comments remain identical. Each handler now has an intentional named export and a local context alias using type-only Pick<AppKeyContext, "state" | "dispatch" | "callbacks">. Global handleAppKey, AppKeyContext and AppKeyCallbacks remain unchanged, including every routing call and its order. The back-reference to the context is type-only, so it creates no runtime cycle.

Before moving, source/debt/protected snapshots were saved; a separate snapshot precedes extraction. AST comparison confirmed both handler bodies and every remaining non-import app-key declaration unchanged. Exact combined source comparison covers all TS/TSX: only the three recorded relocations, import changes, removal of the two clauses from the global file and their export/context declarations are allowed. All other source and test code/assertions remain byte-identical. Full debt ledger, package/lockfile and protected review files are unchanged.

Inventory found two existing Ink/TuiApp uninstall-modal-focus tests in the TUI root. The original plan had understated this coverage; it was corrected explicitly. These tests remain beside TuiApp because they verify global composer/menu focus, not just modal bodyLines. Their existing session fixture debt remains outside this slice. Eleven recorded cases in issue-report/uninstall feature tests also remain.

## Preserved ownership and behavior

Global input precedence, Ctrl+C/Escape contracts, sending/build guards, disclosure/redaction, prepared report ownership, local ZIP before confirmation and credential refusal remain unchanged. Report building/submission is still performed by the existing orchestrator/helpers with injected dependencies; relocation does not provide general cancellation of async work.

Uninstall retains Cancel as initial review focus, nonempty-plan guard, typed confirmation with existing trim/case/cap, closing guard and callback/quit ordering. Removal still follows Ink unmount and awaited runtime shutdown in tui-command. Preview/deletion targets and platform handling remain with the domain. No runtime bootstrap, config defaults/versions, prompt literals or operation algorithm changed.

Guides locate view/state/input and actual operation/resource owners. They distinguish bodyLines, global-key routing and the two Ink focus tests from absent dedicated mouse and exhaustive post-exit coverage.

## Validation

- After relocation and again after extraction: 26 selected files, 332 tests pass. Existing keys still test through handleAppKey; suites include popup/copy, uninstall focus, app/selection, redaction and disposable domain deletion fixtures.
- Full test:ci: 1041 files pass, 12436 tests pass, four existing platform/GC tests skip, exit 0. No tests were added or deleted. Existing HTTP/browser/daemon fixtures use authorized loopback listeners.
- Production lint and test type gate pass; eleven type-checker self-tests pass. Current program includes 2368 roots and 105 test TSX, with the same 904 explicit debt cases. The two new production handlers account for the root increase; the ledger itself was neither reduced nor rebased.
- imports:check: 1347 production modules, 4852 local edges, zero runtime cycles, zero exceptions. All 25 checker fixtures pass; ownership rules are unchanged.
- docs:check passes links, metadata, pointers, archive coverage and instruction budgets; eleven self-tests pass. There are 19 instruction files, maximum chain 8093/24576 bytes.
- Quarantine/workflow registry validation passes with zero active exclusions and two released records. git diff --check passes.

## Limits and next slice

No real GitHub report, operator installation removal or manual terminal/platform QA was performed. Hosted CI and the optional-canvas installation leg were not run locally. The uninstall focus suite covers two keyboard interactions, not dedicated mouse activation or the complete post-exit sequence; issue-report tests use injected dependencies and do not prove every outbound/provider/platform condition. The remaining 904 diagnostic cases stay explicit.

[Plan 03h](../plans/03h-update-ui.md) specifies update presentation and its local offer handler. Version checking/installer execution currently live in domain update and ChatOrchestrator; restart remains a tui-command handoff. Theme and observation/chat-shell still need confirmed ownership classification. Stage 03 is not complete, and no stage 04 plan is created yet.
