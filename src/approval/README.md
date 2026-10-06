# Approval policy and routing

Status: current
Owner: src/approval/

This area owns approval policy and routing. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [approval-gate.ts](approval-gate.ts)
- [approval-router.ts](approval-router.ts)
- [dangerous-tool.ts](dangerous-tool.ts)
- [read-scope-grants.ts](read-scope-grants.ts)

## Ownership and dependencies

ApprovalRouter selects the handler for the owning session; level/grant logic decides whether a dispatch can proceed unattended or needs a decision. Frontends and channel bridges provide interaction, while tools consume the decision. Approval state is separate from offered prompt schemas and from the currently selected UI chat.

## Task-specific reading

Read README.md, ../tools/docs/contracts.md and ../runtime/docs/lifecycle.md before approval/read-scope changes.

## Validation

`npx vitest run src/approval`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
