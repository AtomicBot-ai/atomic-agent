# Terminal interface

Status: current
Owner: src/tui/

This area owns terminal interface. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [tui-app.tsx](tui-app.tsx)
- [tui-state.ts](tui-state.ts)
- [agent-event-reducer.ts](agent-event-reducer.ts)
- [app-key-bindings.ts](app-key-bindings.ts)
- [chat-orchestrator.ts](chat-orchestrator.ts)
- [MCP feature](mcp/README.md)
- [Provider management](providers/README.md)
- [LLM and fallback panel](llm-panel/README.md)
- [LLM health](llm-health/README.md)
- [First-run onboarding](onboarding/README.md)
- [Local model management](local-models/README.md)
- [Memory browsing](memory/README.md)
- [Scheduled tasks](tasks/README.md)
- [Skills management](skills/README.md)
- [External-agent import](import/README.md)
- [Issue reporting](issue-report/README.md)
- [Uninstall confirmation](uninstall/README.md)
- [Update offer and progress](update/README.md)

- [Chat transcript and start page](chat/README.md)
- [Context readout and controls](context/README.md)
- [Coding stance and plan handoff](coding-mode/README.md)
- [Session selection and rail layout](session-rail/README.md)
- [Theme chooser](theme-picker/README.md)
- [Observation views](observe/README.md)
- [Privacy settings](privacy/README.md)
- [Integrations hub](integrations/README.md)
- [Telegram setup adapter](telegram/README.md)
- [Swarm management](swarm/README.md)

## Ownership and dependencies

Feature views now live with their local state/input/orchestration/tests. Global TuiApp/state/actions/reducers/router/submit/layout remain composition points: moving every file into a feature would hide their cross-feature responsibility. ChatOrchestrator coordinates the whole TUI runtime/session lifecycle despite its historical name; runtime/domain owners retain resources.

[Shared primitives and shell composition](components/README.md) classifies every remaining production component. Generic editor/list/logo/formatting and theme remain independent of feature implementations; shell composition can join features. Privacy/integrations/swarm retain their existing local components/ directories without artificial flattening.

## Task-specific reading

Read docs/interface.md for input/layout/orchestrator edits; the underlying domain AGENTS.md when changing its settings or operations.

## Validation

`npx vitest run src/tui`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Dependency ownership](../../docs/architecture/import-boundaries.md) locates the shared list/input primitives, provider adapter and onboarding/composer selectors extracted in stage 02. Shared provider persistence now belongs to config.

## Global approval and terminal infrastructure

[ApprovalModal](approval-modal.tsx) remains part of global approval composition: the same pending request can belong to foreground or detached work and takes precedence across features. [Global keys](app-key-bindings.ts), [submit](submit-handler.ts), [TuiApp](tui-app.tsx) and runtime approvals own decisions/retargeting/focus; the view does not own grants. Existing approval-modal, approval-key-arbitration and approval-live-composer suites remain at the root.

Root terminal detection/restoration/output, turn/session attribution, provider-outage state, layout and cross-feature persistence adapters keep their existing owners. Local guides explicitly link those seams; this organization does not imply every root helper should become feature-local or that all type debt is resolved.

Context maintenance commands are `/compact` and `/compact show`. They use the common menu registry and runtime control inbox, including during a running turn. See [context compaction](../runtime/docs/compaction.md).

Compaction has a session-scoped live indicator: queued requests wait visibly for the current step, running summaries show a spinner, elapsed time and source token estimate, including between turns. The stop button cancels the operation; between turns Esc and Ctrl+C also cancel it, respecting overlay/selection precedence. Switching chats retains each chat's activity without mixing notices or changing agent turn status. [Live integration tests](context/compaction-live.test.tsx) exercise typed commands, queuing, completion, summary viewing and mouse cancellation against the real runtime with scripted model responses.
