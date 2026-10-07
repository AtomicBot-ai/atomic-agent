# Model acquisition and detached downloads

Status: current
Owner: src/local-llm/downloads/

This area owns resumable transfers, model installation helpers and the durable job/worker lifecycle. Read [local model instructions](../AGENTS.md) and the [download contract](../docs/downloads.md). [The root public API](../index.ts) retains its named exports; this directory does not introduce a new barrel. Download completion is separate from server readiness.

## Transfer mechanisms

[download-file](download-file.ts) coordinates attempts, progress, retries and cancellation. [download-attempt](download-attempt.ts) owns an individual transfer; [errors](download-errors.ts) classify retryable and resumable failures. [Partial metadata](download-partial.ts), [resume](download-resume.ts), [segments](download-segments.ts), [rebalance](download-rebalance.ts) and [slow-segment detection](download-slow-segment.ts) own their separate mechanisms rather than duplicating transfer logic for each asset.

A destination is published from its partial only after completion. The sidecar records source identity and completed byte intervals; sparse out-of-order files cannot be treated as a single contiguous prefix. Abort/failure handling keeps usable partials for a later attempt. Existing validation/retry/Range/ETag and no-progress bounds remain part of the implementation contract. Transfer attempts own their readers, file handles, abort controllers and timing; preserve their cleanup on failure as well as success.

[Model installer](model-installer.ts) resolves chat weights, projectors and embedding assets through the [catalog](../catalog/README.md) and the shared [disk layout](../backend-paths.ts), then uses the same transfer engine. The [backend installer](../backend/backend-installer.ts) also consumes that engine while retaining backend staging ownership. A move of source files must not change an asset destination or partial-file format.

## Durable jobs and process ownership

[Jobs](download-jobs.ts) own the JSON record/log path and normalized status contract; [job seed](download-job-seed.ts) supplies initial records, and [staleness](download-job-staleness.ts) handles stale progress using actual liveness/outcome facts. Records survive the initiating UI process. A live job must not be replaced merely because the panel was reopened. Job liveness reuses the [server PID classifier](../server/daemon-lifecycle.ts); this existing dependency does not give a watcher ownership of that process.

[Spawn](download-spawn.ts) launches the detached worker through [runtime self-invocation](../../runtime/self-invocation.ts) with `models pull-worker <kind> <id> <mode>`, rather than deriving a subprocess entry point from this module's location. Preserve Node/SEA argument framing, inherited environment, detached process group, platform handling, appended log descriptor and `unref`; the spawning parent closes its log descriptor in cleanup. The CLI command remains the worker entry point.

[Worker](download-worker.ts) owns transfer progress, heartbeat/waiting state and the final durable record. Its `beforeFinish` seam records notification results before publishing terminal status, because watchers may remove a completed job immediately. [Notification request](download-notify-file.ts) remains a separate sidecar: a UI can arm/disarm a notification while progress writes replace the JSON record. Actual channel delivery belongs to notification/channel owners.

[Paired worker](download-worker-pair.ts) coordinates weights and projector transfers. Cancellation stops the pair and preserves partials. Weights failure stops the projector; a permanent projector failure can still let valid weights land for text-only use. Progress and terminal records must reflect this distinction, rather than claiming vision is ready. Worker heartbeat timers and caller-abort listeners retain their existing cleanup paths.

[Download settings](download-settings.ts) keep the existing precedence of explicit options, environment and config-pushed defaults. Config's established push-in cache remains an existing lifecycle exception; this reorganization adds no new singleton. Config, CLI, TUI and detached workers continue to share the same settings contract.

## Validation and boundaries

Run `npx vitest run src/local-llm/downloads`. Cross-owner changes also need CLI download/command tests, runtime self-invocation, notification delivery and TUI local-model download/pairing/onboarding seams. Then run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`; see [development checks](../../../docs/development.md).

Existing tests use disposable directories, mocked fetch/streams/process launch and recorded catalog definitions. They do not establish real CDN throughput, native process behavior on every platform, a successful model installation or server readiness. No personal data directory or real network pull is needed for a mechanical move.
