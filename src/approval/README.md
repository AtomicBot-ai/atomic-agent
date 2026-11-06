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
- [risk-review.ts](risk-review.ts): smart approval (`agent.smartApproval`, off by default). Before a grantable request prompts, a model rates it low/medium/high under a grammar or one-field schema; `low` runs it, anything else and every failure prompts with `riskNote`. Fail-closed; never for non-grantable categories, `fs_read_outside` or a session under a refuse policy. Wired by [runtime-risk-review](../runtime/composition/runtime-risk-review.ts).
- [approval-preview.ts](approval-preview.ts): fits a long preview onto a size-limited surface (TUI modal, Telegram message) by whole lines, with an explicit "+N more lines" note instead of a silent cut, and pages the whole preview (`pagePreview`) for a surface that shows all of it before the decision.

## Ownership and dependencies

ApprovalRouter selects the handler for the owning session; level/grant logic decides whether a dispatch can proceed unattended or needs a decision. Frontends and channel bridges provide interaction, while tools consume the decision. Approval state is separate from offered prompt schemas and from the currently selected UI chat.

## Task-specific reading

Read README.md, ../tools/docs/contracts.md and ../runtime/docs/lifecycle.md before approval/read-scope changes.

## Validation

`npx vitest run src/approval`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
