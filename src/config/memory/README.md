# Memory configuration

Status: current
Owner: src/config/memory/

This directory owns validation and compatibility for the entire stored memory policy. Inherit [config instructions](../AGENTS.md) and read [compatibility](../docs/compatibility.md) for migration/default changes. Runtime storage and formation/retrieval belong to [memory](../../memory/README.md).

## Entry points

- [memory-types.ts](memory-types.ts): runtime/user memory shapes and the rewriter gate-mode union; no source imports. The two public shapes retain their original ordered declarations.
- [memory-defaults.ts](memory-defaults.ts): fresh mutable default construction, importing only the owned types. Root schema creates its exported defaults once.
- [memory-parser.ts](memory-parser.ts): early raw-reference preparation, late ordered normalization, the existing gate-mode validator and pre-v22 feature handling. It reads explicit current defaults and uses concrete scalar/value/error and [subcall-timeout migration](../subcall-timeout-migration.ts) owners.

Read the relevant field definitions, parser block and default fields for a policy change. Root [config-schema](../config-schema.ts) owns whole-file version acceptance and assembly and retains its public gate-mode exports; consumers keep their existing imports. There is no separate runtime cache or mandatory barrel API here.

## Compatibility boundaries

Preparation retains raw subblock references before webhook/local-model validation and performs no scalar validation or default lookup. Normalization stays after session retention/tracing and before vision/skills/frontend sections. Each old fallback reads the current mutable defaults at its original position; do not cache the nested default object.

Seven pre-v22 feature flags preserve their legacy forcing behavior and unconditional default-argument reads. Three sub-call timeouts preserve the shared pre-v65 exact-old-default migration and repeated current-default reads. Disabled subsystems still validate their other fields. Plain-object restrictions, weight normalization and new cross-field clamps do not belong to a compatibility extraction.

## Checks

Run `npx vitest run src/config`, relevant memory and prompt/agent seam suites, `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. [The adjacent suite](memory-config.test.ts) covers normalization/version/default-reference seams; existing schema and shared timeout tests retain whole-file coverage.
