# Shell execution and detached jobs

Status: current
Owner: src/tools/os/shell/

This area owns the implementation of `os.shell.run`, including its command, jobs, wait and kill forms. Read the inherited [tool instructions](../../AGENTS.md) and [tool contract](../../docs/contracts.md) before changing dispatch behavior. Registration stays in the [OS registry](../index.ts).

## Code and resource owners

- [shell.ts](shell.ts) validates calls, chooses direct argv or subshell execution, requests approval through the existing guard policy and handles timeout/abort outcomes. [shell-interpretation.ts](shell-interpretation.ts) owns argument coercion and interpretation decisions; [expand-shell-glob-args.ts](expand-shell-glob-args.ts) expands supported structured argv globs. Shared user-path expansion stays in [expand-home.ts](../expand-home.ts).
- [shell-timeout.ts](shell-timeout.ts) resolves explicit/default timeouts and renders notices. A default timeout can detach a still-running command; an explicit timeout expresses a kill bound. Preserve that distinction when touching orchestration.
- [shell-jobs.ts](shell-jobs.ts) owns per-session records and ceiling timers around sandbox CommandJob instances. Runtime bootstrap injects its registry and calls endTurn/endSession/endAll; kept jobs survive turn end, but not session/shutdown/ceiling cleanup. Embedders that omit a registry get the documented private-registry behavior.
- [shell-job-calls.ts](shell-job-calls.ts) handles job lookup, wait, kill, collection and detached-result rendering. IDs are scoped to the session that started the job.
- [shell-result.ts](shell-result.ts) renders output and exit/timeout observations. [node-check-notice.ts](node-check-notice.ts) explains commands whose successful exit does not establish that every named file was checked.

The existing [shell-command-guard](../shell-command-guard/index.ts) owns command classification, normalization and policy rules. It is shared with agent verification command classification and remains a separate owner. Approval owns grants and interaction; sandbox owns process execution. This directory does not own runtime shutdown ordering or configuration defaults.

## Validation

Run `npx vitest run src/tools/os/shell src/tools/os/shell-command-guard` and affected runtime lifecycle seams for job ownership changes. Adjacent suites cover command policy, detach, jobs, result formatting, timeouts, argv glob expansion and node-check notices. Use disposable directories and fixtures. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check`; preserve catalog/resource-class coverage when changing registration. Moving modules does not authorize changing tool descriptions, approval rules or process lifecycle.
