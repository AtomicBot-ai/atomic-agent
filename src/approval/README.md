# Approval policy and routing

Status: current
Owner: src/approval/

This area owns approval policy and routing. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [coding-mode.ts](coding-mode.ts): shared default/plan/auto/bypass mapping and mode metadata; frontends adapt its policy to their controls.
- [approval-gate.ts](approval-gate.ts)
- [approval-router.ts](approval-router.ts)
- [dangerous-tool.ts](dangerous-tool.ts)
- [read-scope-grants.ts](read-scope-grants.ts)
- [approval-rules.ts](approval-rules.ts): saved allow / ask / deny rules (ATO-1141): parse, validate, `matchRules` (deny > ask > allow; an allow never applies to a category `isGrantableCategory` rejects), and the rule "Allow always" saves (`buildAlwaysRule`, `canGrantAlways`, `describeAlwaysRule`). A rule's optional `origin` matches the request's `grantKey`; an "Allow always" on `os.http.request` saves its target origin there, so it covers one host only (ATO-1471). Pure.
- [approval-rules-store.ts](approval-rules-store.ts): the files. Global `<stateDir>/approval-rules.json` (allow / ask / deny, optionally `project`-scoped; a write asks as `trust_config`, a read as `state_secret`) and per project `<workdir>/.atomic-agent/approval-rules.json`, where only ask and deny count because the model can write in the workspace. Reloads on a stat change, writes tmp + rename at 0600, and treats a missing or unreadable file as empty (an unreadable one is logged and moved aside before the next save).
- [approval-workdir.ts](approval-workdir.ts): the dispatching tool call's session folder, so the gate can scope rules to a project without threading it through every tool.
- [risk-review.ts](risk-review.ts): smart approval (`agent.smartApproval`, off by default). Before a grantable request prompts, a model rates it low/medium/high under a grammar or one-field schema; `low` runs it, anything else and every failure prompts with `riskNote`. Fail-closed; never for non-grantable categories, `fs_read_outside` or a session under a refuse policy. Wired by [runtime-risk-review](../runtime/composition/runtime-risk-review.ts).
- [approval-preview.ts](approval-preview.ts): fits a long preview onto a size-limited surface (TUI modal, Telegram message) by whole lines, with an explicit "+N more lines" note instead of a silent cut, and pages the whole preview (`pagePreview`) for a surface that shows all of it before the decision.

## Ownership and dependencies

Gate order in `ApprovalGate.request`: the same-turn refusal (`declinedInTurn`), a matching deny rule (refused, `automatic`), a matching ask rule (skips the level and grants and prompts), the level, the session grant, a matching allow rule, then the session's refuse policy or the prompt. `resolve({ grant: "always" })` saves the allow rule built from the pending request, scoped to its project; hardline shell-guard rules fire before the gate and no rule touches them. A fan-out scope returns before the gate, so the tools ask `ruleDecisionFor` first: a deny or ask rule sends the call to the gate. A shell command the guard deems safe never asks either, so `os.shell.run` asks `ruleDecisionFor` for it too: a deny rule sends it to the gate, which refuses it (ATO-1332). Deny and ask rules match every command in `commandSegments`: past wrappers and their value flags (`sudo -u root`, `nice -n 5`, `timeout 5`, `env -u X`, `xargs -n 1`), inside a nested `sh|bash|zsh|dash|ksh|fish|csh|tcsh -c` line, `eval` and `find -exec` (`shellRuleSegments`). A script fed to a bare shell or interpreter through a pipe, a redirect or a heredoc (`printf … | sh`) cannot be read, so the request is marked `commandUnreadable` and any deny or ask command rule matches it. An allow rule still needs `commandArgv`. A worker in a throwaway worktree matches rules against its parent's project (`SessionApprovalPolicy.ruleWorkdir`). `wouldPrompt` (the fan-out's pre-check) follows the same order: a deny or allow rule means no prompt, an ask rule means a prompt whatever the level or a grant (ATO-1270).

ApprovalRouter selects the handler for the owning session; level/grant logic decides whether a dispatch can proceed unattended or needs a decision. Frontends and channel bridges provide interaction, while tools consume the decision. Approval state is separate from offered prompt schemas and from the currently selected UI chat.

## Task-specific reading

Read README.md, ../tools/docs/contracts.md and ../runtime/docs/lifecycle.md before approval/read-scope changes.

## Validation

`npx vitest run src/approval`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
