# Managed server lifecycle and resource policy

Status: current
Owner: src/local-llm/server/

Read the parent [local-llm instructions](../AGENTS.md) and [lifecycle contract](../docs/lifecycle.md). This owner manages the external llama-server process when callers request a managed launch; external-mode clients connect without acquiring ownership of an operator's server. CLI, runtime and TUI retain their own orchestration, mode selection and shutdown responsibilities.

## Launch and process ownership

[Daemon lifecycle](daemon-lifecycle.ts) owns chat and embedding launch/status/stop operations, launch records, readiness and throughput observations. The chat daemon starts first; embedding startup is an optional secondary whose failure does not undo a successful chat launch. The corresponding paired shutdown retains its existing ordering. Processes are detached with file-backed logs and PID records; a terminal's lifetime does not define a daemon's lifetime. Failed post-spawn readiness abandons the launched child and its PID record.

[Launch guard](daemon-launch-guard.ts) checks that the port was free, observes the actual child's exit during readiness, and validates the served model alias when the server provides it. Another process answering health must not make a failed launch look successful. [Port holder](port-holder.ts) reads best-effort OS evidence; unknown ownership stays unknown. [Port reclaim](port-reclaim.ts) can adopt a matching daemon from the same data directory, stop an eligible managed holder, or move to another port. It leaves foreign or actively used holders alone; a detached process having no parent is not abandonment evidence.

PID liveness distinguishes dead and live foreign-owned processes. Stop operations preserve tracking when signalling is forbidden and retain Windows/POSIX handling. Callers apply managed/external mode and stopOnExit policy. [Session registry](session-registry.ts) supplies advisory live-session markers and an idempotent release callback so an exiting TUI does not stop a daemon another session uses. These markers are not locks.

## State, credentials and observations

[Shared paths](../backend-paths.ts) remain the single source of persisted model/backend/PID/log/launch/throughput/key locations. Moving source files does not rename data or migrate records. [Managed API key](managed-api-key.ts) owns persisted key creation and reuse, owner-only file permissions and Windows ACL application, loopback routing and child-environment propagation. It sends the server key through the child's environment rather than process arguments and does not mutate the parent's environment. It also preserves configured versus persisted-key precedence and the existing best-effort failure behavior.

[Log tail](log-tail.ts) reads bounded file tails and closes its file descriptor. [Server fault](server-fault.ts) recognizes known log signatures only within the latest managed launch marker; unrecognized output does not manufacture a diagnosis. Throughput records in daemon lifecycle retain model/backend/device/context evidence, age checks and whether a sample ran alone. A running or healthy server does not establish throughput by itself.

## Resource policies and dependency seams

[Context size](context-size.ts) contains pure KV layout/cost and memory-fit calculations; daemon lifecycle supplies actual header/device/system evidence and operator overrides. [SWA policy](swa-full.ts) weighs full sliding-window cache against the available launch budget and explicit preference. [Worker slots](worker-slots.ts) counts complete worker footprints within the actual context pool, distinguishes local workers from a local orchestrator, and preserves pinned slot counts. These are launch policies; they are not additional probes or alternate config defaults.

Header/catalog information comes from [catalog](../catalog/README.md); installed backend versions, platform selection and device probes come from [backend](../backend/README.md). Backend update/fallback already consumes selected server operations, while lifecycle consumes separate backend metadata/probes. This is an acyclic module graph, not a blanket hierarchy between whole directories. Internal modules import concrete owners rather than the [public local-llm index](../index.ts), whose named exports remain the existing CLI/TUI/runtime contract. Download jobs reuse PID liveness from daemon lifecycle; ownership changes are separate from this source move.

## Checks and limits

Run `npx vitest run src/local-llm/server` after cross-owner imports are integrated. Include existing local-llm backend update/fallback suites and affected CLI models, TUI daemon restart/port clearance/wedge/hybrid recall, LLM health/profile, runtime local-probe/embedding-auth, memory embeddings and prompt/fusion seams when their interface is involved. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check`, `npm run docs:check` and the full `npm run test:ci` for acceptance.

The adjacent suites use existing mocks and disposable fixtures; launch-guard and port-reclaim tests need local loopback listeners. Passing these checks does not establish actual llama-server startup, GPU measurements, Windows ACL/process behavior on a Windows host, or external-mode manual operation. No real server/download or user data operation is a verification step for a mechanical move.

Managed launch options accept an AbortSignal. A superseded health wait aborts and
the lifecycle removes only the child it spawned before returning. Interactive
clients disable the optional throughput probe so readiness follows daemon health;
`models start --interactive` exposes this policy to the desktop client. Ordinary
`models start` keeps its existing benchmark behavior.
