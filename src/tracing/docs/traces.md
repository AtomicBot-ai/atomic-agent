# Trace contracts and replay

Status: current
Owner: src/tracing/

TraceRecorder creates per-session NDJSON events with monotonic sequence and truthful timing/provider/batch attribution. A batch creates one invocation event per result, with batch metadata where appropriate, and one inference reasoning block is not duplicated as multiple independent inferences.

Trace payloads contain local sensitive prompt/completion/tool data. The cap rewrites whole tail lines with a trace_truncated marker; append-only is therefore qualified by cap rotation. Complete secret redaction is not promised. Replay compares stable-prefix drift; optional inference replay does not reproduce external filesystem/browser state or model determinism.

Sources: [events](../trace/trace-event.ts), [recorder](../trace/trace-recorder.ts), [replay](../../replay/replay-session.ts). Tests: [recorder](../trace/trace-recorder.test.ts). Outbound scrubbing: [error reporting](../../error-reporting/README.md).
