# Tool registry and adapters

Status: current
Owner: src/tools/

This area owns tool registry and adapters. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [tool-registry.ts](tool-registry.ts)
- [tool-roles.ts](tool-roles.ts)
- [unknown-argument-guard.ts](unknown-argument-guard.ts)
- [control-marker-guard.ts](control-marker-guard.ts)

## Ownership and dependencies

ToolRegistry owns registered definitions and invocation; role predicates and discovery determine offered schemas. OS/browser/memory/conversation tool families implement operations using explicit ToolContext dependencies. Agent dispatch owns approval, batching and progress guards; prompt owns descriptors and LLM adapters own wire schemas. A catalog change crosses these boundaries.

[Core filesystem contracts](os/fs/docs/contracts.md) group 13 operations' metadata and pure argument semantics. [Global conformance](tool-contract-conformance.test.ts) inspects actual static registrations before replacement and catalog/schema/class surfaces; [runtime composition tests](../runtime/tool-contract-composition.test.ts) pin feature gates and read-scope decoration. See [contracts](docs/contracts.md) for validation limits and existing catalog debt.

## Task-specific reading

Read docs/contracts.md for tool additions/changes and ../agent/docs/batching.md for dispatch; adjacent tool tests for argument behavior.

## Validation

`npx vitest run src/tools`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
