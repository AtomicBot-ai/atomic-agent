# Issue reports

Status: current
Owner: src/tui/issue-report/

The report workflow collects explicitly selected diagnostic material with privacy levels, redaction and bounded packaging before external submission. Do not equate local trace contents with safe-to-upload data or silently widen report scope.

Read [TUI instructions](../AGENTS.md), [levels](report-levels.ts), [error scrubbing](../../error-reporting/README.md), and adjacent issue-report tests. Publishing a report is an external action, not a documentation verification step.

## Presentation and input

[IssueReportPopup](issue-report-popup.tsx) displays level selection, building, confirmation, sending, link and error screens. [TuiApp](../tui-app.tsx) composes it as a modal using shared mouse/theme/width helpers. [State/reducer](issue-report-state.ts) own transitions; [local keys](issue-report-key-bindings.ts) call the existing callbacks. The handler takes only the state/dispatch/callback portion of AppKeyContext through a type-only dependency.

[Global keys](../app-key-bindings.ts) still determine precedence and call this handler in the same place above approval input. Ctrl+C keeps the global path; sending blocks ordinary dismissal, building allows Escape, and close forgets the prepared report as well as closing the UI. Existing key tests enter through handleAppKey to cover that seam.

## Operations and resources

[IssueReportOrchestrator](issue-report-orchestrator.ts) owns prepared report state, busy and generation guards. It builds the selected [report](build-issue-report.ts), [packs the body](issue-body.ts) and [writes the ZIP](write-report-zip.ts) before showing confirmation with path, size, disclosure and destination. Redaction lives in [text](redact.ts) and [trace](trace-redaction.ts) helpers; local trace data is not automatically safe to publish.

Closing increments the generation so an obsolete build result cannot reopen the popup. This is a result guard, not general cancellation of asynchronous work. Sending uses the existing credential refusal and injected GitHub API seam; the view does not send anything itself. Runtime retains store/tracing ownership, and moving files does not change disclosure levels, packaging limits or resource lifetimes.

## Checks

Run `npx vitest run src/tui/issue-report src/tui/uninstall src/tui/uninstall-modal-focus.test.tsx src/tui/app-key-bindings.test.ts src/tui/app-key-bindings-selection.test.ts src/tui/tui-app.test.tsx src/uninstall src/error-reporting`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Use full `npm run test:ci` for acceptance.

Adjacent suites cover popup rendering, global-key routing, state, report/body construction, redaction and portions of orchestration with injected dependencies. They do not imply manual terminal/platform QA or a real outbound report. Seven existing orchestrator test-type cases remain explicit debt.
