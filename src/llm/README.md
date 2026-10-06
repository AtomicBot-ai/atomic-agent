# Inference protocols and model profiles

Status: current
Owner: src/llm/

This area owns inference protocols and model profiles. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [model-profile.ts](model-profile.ts)
- [profile-invariants.ts](profile-invariants.ts)
- [server-template-policy.ts](server-template-policy.ts)
- [llama-server-client.ts](llama-server-client.ts)
- [slot-manager.ts](slot-manager.ts)

## Ownership and dependencies

Model profiles connect prompt framing, grammar and streamed parsing. Provider adapters own transport-specific request/response formats; fallback owns per-session provider stickiness and probes. SlotManager coordinates local inference resources while runtime owns wiring. Inspect provider/openai for strict or tagged schema changes and grammar for constrained local decoding.

## Task-specific reading

Read docs/profiles.md for framing/grammar and docs/fallback.md for reliability; provider/openai tests for wire/schema changes.

## Validation

`npx vitest run src/llm`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
