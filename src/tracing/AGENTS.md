# Traces and observability

Scope: `src/tracing/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep per-session sequence, batch attribution and truthful provider/model/timing fields. One inference reasoning block is not duplicated across sibling calls.
- Traces retain sensitive prompt/completion data locally; do not claim complete redaction. Cap rotation retains whole tail lines and a truncation marker.
- Replay checks prompt drift; it is not a simulation of external world state or LLM determinism.

## Read when relevant

Read docs/traces.md for event/trace/replay changes; ../error-reporting/README.md for outbound error scrubbing.

## Checks

Run `npx vitest run src/tracing` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
