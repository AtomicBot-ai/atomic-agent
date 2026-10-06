# Inference protocols and model profiles

Scope: `src/llm/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Profile, prompt framing, grammar and streamed parsing must remain aligned. Qwen prefills the reasoning opener; Gemma emits its opener in native turn framing.
- Keep per-request grammar restrictions out of the cached prompt. Bound the reasoning body and trailing whitespace; preserve terminal-step and thinking-off variants.
- Propagate the transport that actually served a fallback completion and stream. Do not parse a grammar response as native tools or reopen native reasoning.
- Strict schemas are converted per tool and optional null removal is per widened argument. Preserve refused schemas and required nullable arguments; strict emitted tools disable parallel_tool_calls.
- Provider retry/fallback must respect cancellation and stream commitment. Breaker state is partitioned by session; probes are lazy, not a new timer.

## Read when relevant

Read docs/profiles.md for framing/grammar and docs/fallback.md for reliability; provider/openai tests for wire/schema changes.

## Checks

Run `npx vitest run src/llm` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
