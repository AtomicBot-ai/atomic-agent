# Durable cross-session memory

Status: current
Owner: src/memory/

This area owns durable cross-session memory. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [memory-store.ts](memory-store.ts)
- [profile-store.ts](profile-store.ts)
- [memory-context-provider.ts](memory-context-provider.ts)
- [reflection-runner.ts](reflection/reflection-runner.ts)
- [extract-fact-candidates.ts](import-facts/extract-fact-candidates.ts): facts from an old chat export, for the person to approve (ATO-1060)

## Ownership and dependencies

MemoryStore and specialized profile/link/lesson/procedure/vote stores own persistence. The context provider retrieves bounded prompt material; reflection and its runners form or curate durable data; consolidator owns scheduled distillation. Runtime supplies provider/slot posture and shutdown; prompt owns placement and budgets. Read retrieval and formation independently.

## Task-specific reading

Read docs/retrieval.md for recall and docs/formation.md for reflection/consolidation; ../prompt/AGENTS.md for rendering.

## Validation

`npx vitest run src/memory`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
