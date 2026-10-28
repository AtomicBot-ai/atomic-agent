# Project folder trust prompt

Status: current
Owner: src/tui/project-trust/

The one-time startup question about the opened folder's project skills and instruction files. The rule, storage and HTTP equivalent belong to [project folder trust](../../skills/docs/project-trust.md); this feature only shows the question and passes the answer on.

[ProjectTrustOrchestrator](project-trust-orchestrator.ts) inspects the launch folder once at startup, emits `project_trust_asked` when something is pending and records the answer through the runtime helpers, then refreshes the local catalog and the Skills panel. A question that went stale (a new skill or file appeared) is asked again with the current counts. [Keys](project-trust-key-bindings.ts): `y` trusts, `n` declines and is remembered, `Esc` closes without an answer so the next start asks again; modified and other input passes through. [Modal](project-trust-modal.tsx) is composed by TuiApp next to the update offer; the [global router](../app-key-bindings.ts) keeps approval priority.

Tests: [keys](project-trust-key-bindings.test.ts), [orchestrator](project-trust-orchestrator.test.ts).
