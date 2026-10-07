# Local model configuration

Status: current
Owner: src/config/local-models/

This directory owns stored local-model configuration validation and compatibility. Inherit [config instructions](../AGENTS.md); read [compatibility](../docs/compatibility.md) for default/migration changes. Server processes, downloads, hardware and model assets belong to [local-llm](../../local-llm/README.md).

## Entry points

- [local-models-types.ts](local-models-types.ts): separate ordered runtime/user shapes and the existing local-model configuration types. Dependencies are type-only references to concrete catalog/backend/SWA owners.
- [local-models-defaults.ts](local-models-defaults.ts): fresh mutable default objects and arrays; imports the owned types and existing download/Hugging Face constants. The composing schema constructs its exported defaults once.
- [local-models-parser.ts](local-models-parser.ts): early preparation, late normalization, existing validators and version-dependent helpers. It receives current defaults explicitly and uses concrete validation/catalog/backend helpers, without starting servers or downloads.

Root [config-schema](../config-schema.ts) retains whole-file version acceptance, overall assembly, LLM-provider composition and compatible type/function exports. New construction/preparation APIs are internal to this composition; no mandatory barrel is needed. Environment precedence stays in [load-config](../load-config.ts).

## Compatibility seams

Early preparation validates custom models, managed settings, embedding port before enabled, download settings, mode and URL in that order. A managed selection can refer to a custom model declared in the same file. Root then composes LLM providers from those captured values. Completion/template/thinking/reasoning fields normalize later, preserving which error is reported first when several inputs are invalid. The original raw reference is retained for that late phase.

Each fallback expression reads current mutable defaults at its original position. Pre-v41 auto-update forcing and explicit parallel `auto` bypass default reads; pre-v63 pinned parallel values retain their existing migration. Tensor split and custom models do not inherit mutated default arrays. Absent embedding URL is derived from the validated port, while an unknown nonempty embedding model ID retains its existing acceptance.

Disabled/external modes still validate their settings. Keep existing null, coercion, general URL scheme and Hugging Face path-prefix behavior; config parsing does not acquire filesystem, process or network policy. Scalar bounds and error messages remain defined by the source and existing tests.

## Checks

Run `npx vitest run src/config`, selected CLI/TUI persistence and local-llm/LLM profile seams, `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. [Adjacent tests](local-models-config.test.ts) cover the phase/default/migration seams; existing schema and custom-model suites retain whole-file coverage.
