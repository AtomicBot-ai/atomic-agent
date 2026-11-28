# Prompt assembly and cache contracts

Status: current
Owner: src/prompt/

This area owns prompt assembly and cache contracts. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [build-prompt.ts](build-prompt.ts)
- [stable-prefix.ts](stable-prefix.ts)
- [token-budget.ts](token-budget.ts)
- [tool-descriptors.ts](tool-descriptors.ts)

## Ownership and dependencies

build-prompt composes the bounded model context from explicit session inputs. stable-prefix owns cache-sensitive catalog bytes; token-budget and conversation-pack own allocation and retained transcript cuts. Provider profiles determine framing, and tool descriptors supply catalog contracts. Assembly does not own durable session or memory stores.

[Model behavior mode](../llm/docs/model-mode.md) selects two projections. `local` retains existing budgets, packing and result aging. [Cloud assembly](build-cloud-prompt.ts) preserves full selected content in a persisted, append-only message history, with state updates after conversation and no presentation quotas. Both paths share the stable prefix. Assembly and preview produce a pure candidate; runtime owns committing it before inference.

[prompt-breakdown.ts](prompt-breakdown.ts) reads a built prompt back into parts for the context panel (ATO-2355): one per stable-prefix `### ` section, the tool catalog and `### loaded-tools` split into built-in tools and one part per MCP server. It parses the assembled text only, never changes it, and the parts of a section sum to that section's token figure. An MCP server's part also lists its tools (ATO-2453); [prompt-part-shares.ts](prompt-part-shares.ts) does the pricing for both. [tool-schema-parts.ts](tool-schema-parts.ts) measures a `native_tools` request's `tools` array (`toolSchemaTokens`, unchanged) and splits it the same way into `toolSchemaParts`, which `buildPrompt` passes through to `BuiltPrompt.toolSchemaParts` only while the schemas are counted.

The 14 core filesystem entries in descriptor-A and the default JSON schema map consume explicit projections from [import-free operation contracts](../tools/os/fs/docs/contracts.md). Catalog positions, args text and serialized schema order stay unchanged. Rendering does not import execution or own its argument semantics. [Global conformance](../tools/tool-contract-conformance.test.ts) checks the actual catalog and requires unique descriptor names (the old [Git duplicates](../../docs/proposals/tool-catalog-deduplication.md) are gone); other families retain their existing owners.

## Task-specific reading

Read README.md and docs/assembly.md for prompt/budget edits; ../tools/AGENTS.md for descriptor/schema edits.

## Validation

`npx vitest run src/prompt`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
