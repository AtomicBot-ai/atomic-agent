# Traces and observability

Status: current
Owner: src/tracing/

This area owns traces and observability. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [agent-metrics.ts](agent-metrics.ts)
- [structured-logger.ts](structured-logger.ts)
- [trace-recorder.ts](trace/trace-recorder.ts)
- [trace-event.ts](trace/trace-event.ts)

## Ownership and dependencies

Trace events record inference, tools, memory and lifecycle observations. TraceWriter owns persistence/rotation, with schema helpers defining replayable records; analysis and replay consume those records. Runtime supplies session/turn attribution, and provider/step code supplies measured completion data. Logging must preserve redaction and event ordering.

## Task-specific reading

Read docs/traces.md for event/trace/replay changes; ../error-reporting/README.md for outbound error scrubbing.

## Validation

`npx vitest run src/tracing`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
