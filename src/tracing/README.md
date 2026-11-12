# Traces and observability

Status: current
Owner: src/tracing/

This area owns traces and observability. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [agent-metrics.ts](agent-metrics.ts)
- [structured-logger.ts](structured-logger.ts)
- [trace-recorder.ts](trace/trace-recorder.ts)
- [trace-event.ts](trace/trace-event.ts)
- [otlp-trace-sink.ts](otel/otlp-trace-sink.ts)

## Ownership and dependencies

Trace events record inference, tools, memory and lifecycle observations. TraceWriter owns persistence/rotation, with schema helpers defining replayable records; analysis and replay consume those records. Runtime supplies session/turn attribution, and provider/step code supplies measured completion data. Logging must preserve redaction and event ordering.

## OpenTelemetry export

Trace events can also go out as OpenTelemetry spans ([otel/](otel/)), to Langfuse, Phoenix, Jaeger, W&B Weave, Grafana Tempo or any OTLP collector. It is off by default and turns on when an endpoint is known: `tracing.otel.endpoint` in `config.json`, or the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, `/v1/traces` is appended) / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used as given). The environment wins over the config. `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (`key=value,key2=value2`, percent-encoded) add request headers to `tracing.otel.headers`; `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` set the resource. `tracing.otel.enabled: false`, `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` keep it off. It works with the local NDJSON traces on or off.

What is sent: one trace per turn, rooted at an `invoke_agent` span, with a `chat` span per model call and an `execute_tool` span per tool call, named after the GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` / `gen_ai.response.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.usage.cost` when the provider reported a cost, `gen_ai.tool.name`, `error.type`). The session id is `gen_ai.conversation.id` and `session.id` on every span. Other trace rows inside a turn (retries, loop detection, compaction) become span events with their numeric and fixed-vocabulary fields only.

Prompt, reply, tool argument and error text stay out of spans unless `tracing.otel.captureContent` is `true`; even then every string goes through the shared secret masker (`error-reporting/secret-detector.ts`) and a length cap. Export is OTLP over HTTP with JSON encoding, sent with the built-in `fetch` (no OpenTelemetry SDK, no auto-instrumentation, so the SEA binary is unaffected). Spans are batched (512 per request, at most 5 s wait, a 2048-span queue that drops the oldest) and flushed on shutdown with a 3 s limit; a failing endpoint is logged once per run of failures and never affects a turn. If a backend accepts only protobuf, put an OpenTelemetry Collector in front of it.

Example endpoints (check each backend's own docs for the current URL and auth):

- Jaeger, local: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
- Phoenix, local: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006`.
- Langfuse Cloud: `OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64 of public-key:secret-key>`.
- W&B Weave: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://trace.wandb.ai/otel/v1/traces`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64 of api:API-key>,project_id=<entity>/<project>`.

## Task-specific reading

Read docs/traces.md for event/trace/replay changes; ../error-reporting/README.md for outbound error scrubbing.

## Validation

`npx vitest run src/tracing`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
