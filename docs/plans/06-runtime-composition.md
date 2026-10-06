# Этап 06: публичный runtime contract и явная сборка ресурсов

Status: verified
Owner: repository maintainers

Создан после [полной приёмки05](../testing/stage-05-validation.md). База: bootstrap4319 строк, config schema1521, 848 existing test diagnostics, 0 cycles/exceptions; full1059 suites/12792 passed/4 existing skips. Read-only исследованы runtime instructions/lifecycle, FIFO/steering/in-flight/subcalls, fallback/provider seams и existing tests. Implementation06 начата после fresh immutable snapshot. Это единый этап с двумя внутренними волнами disjoint parallel work и общей приёмкой, без отдельных06a/b/c планов. APIs уточняются на fresh post05 snapshot до переноса.

## Контекст, цель и границы

bootstrap.ts (~4319 строк current research) объявляет публичные runtime types, открывает stores, настраивает providers/slots/tools/memory, реализует turn lifecycle, запускает channels/jobs и закрывает ресурсы. Часть behavior уже имеет владельцев (TurnController, SteeringInbox, TurnsInFlight, fallback/link seams, local profile manager), однако wiring и closures смешаны в одном файле. src/runtime/index.ts сейчас НЕ существует: current public import owner — bootstrap.ts.

Цель: оставить bootstrap явным последовательным composition root, выделить читаемый public type contract и компоненты с локальным состоянием, точными dependencies и ownership ресурсов. Не превращать root в сервис-локатор/DI-framework, не разнести строки по равноразмерным файлам и не переписать loop. Public names/call signatures/config/prompt/grammars/defaults/persisted JSON остаются compatible. Stage07 agent loop/step/policies, provider retry/strict schema rewrite, новые globals, monorepo и отказ от executeTurn не входят.

## 1. Сначала контракт и observable baseline

Новый src/runtime/runtime-contract.ts: exact RuntimeEventHandlers, CreateAgentRuntimeOptions, AgentRuntime declarations/member comments/order с type-only inward imports. bootstrap сохраняет прежние type reexports и runtime exports createAgentRuntime/managedLocalLlmHealthFailureHint; public runtime function identity/export list не меняется. runtime-contract не импортирует bootstrap/composition/modules ради implementation types. Не создавать index.ts как новый неограниченный public barrel. Existing frontend imports не требуют массовой миграции; несколько внутренних imports можно перевести на concrete type owner отдельным механическим изменением, либо оставить compatible reexports.

Сначала pin public TS signatures/shapes/order/optionality; object property descriptors/enumerability; readonly vs mutable; getter behavior; methods/error identity. Runtime fields имеют неодинаковую semantics:

- skillCatalog/skillCatalogDropped/toolDescriptors — live getters;
- loopDeps grammar/descriptor/transport/adapter/slot/parallel/strict values читаются late через getters;
- runtime.grammar сейчас обычная snapshot property: refreshMcp меняет closure grammar, но не runtime.grammar. Не исправлять этот pre-existing mismatch превращением runtime field в getter попутно. Записать distinction и отдельный behavioral issue;
- config — boot snapshot, а provider/mode/approval/session policies местами intentionally reread getConfig/live owners. Не заменять все значения единым «fresh config» getter;
- telegram/discord/swarm сначала null в façade, затем устанавливаются на ту же stable runtime reference; nullability API сохраняется, даже когда actual constructor unconditional;
- executeTurn — public compatible already-locked seam, не новое безопасное право вызывать его без FIFO;
- createEphemeralSession никогда не persists/opens trace; createSession persist:false deferred, первый normal turn сохраняет.

До edits fresh immutable whole-src/package/compiler/debt/protected snapshot, actual runtime exports/types, config/default/version and prompt/grammar/canonical tool baselines из принятого05. Не reuse 05k/05l in-progress tree. Capture startup operation order и normal shutdown order с typed fakes/actual temp stores, static vs live fields, FIFO acquisition/cancel/routing/persistence, role catalog/wire output.

## 2. Предлагаемые владельцы и exact files

Bootstrap остаётся единственным владельцем порядка между компонентами и сборки AgentLoop deps/публичного façade. Новый каталог src/runtime/composition/ — internal construction recipes; нет отдельного package или mandatory index. Internal exports имеют описательные имя/результат; consumers не передают whole AgentRuntime, кроме channels где это intentional public frontend dependency.

### Observability

runtime-observability.ts — logger/metrics + analytics/error reporting construction/live toggle/report methods/usage metering; process-wide transport/error-handler setup остаётся explicit boot action в root, не маскируется как per-runtime disposer.

runtime-traces.ts — trace bus/recorder LRU, pinned active sessions/pending drop maps/context-usage accounting; ensure/touch/drop/pin/end methods. Recorder cap64, exempt just-created recorder, active over-cap behavior, beginSession once и deletion mid-turn ordering exact. ALS-owned session context и emitFor(sessionId,event) остаются explicit; fusion progress uses PARENT id even when worker ALS active.

Deps logger/metrics/handlers/live error reporter getter; no tool execution/provider registry/root import. SessionStore binding через narrow callbacks; allocation and deletion wrappers attach at old positions. Это два ответственности, не «observability mega context» всех runtime fields.

### Inference wiring

runtime-inference.ts — recipes для local llama/model profile/slot boot resolution, DeferredLocalBackendProbes/prepareLocalLink, provider registry construction and live slice/mode/vision/pricing/context-window getters, fallback factory/usage callbacks, reloadProvider(s)/refreshLocalModelProfile. Если один owner превышает разумную самостоятельную ответственность, отделить runtime-local-profile.ts для boot health/profile/slot recipe; это технический module, не новый план.

Phased API required: local profile/slots раньше stores/tools; provider registry AFTER grammar/profile manager. Нельзя собрать everything одной eager factory и передвинуть probes. SlotManager один owned instance; reflection/distill sideCallSlotId остаётся callback позднего reserve; worker pin bypass fallback. Existing fallback-seam/link-attempt/learned-context/vision-route/pricing modules остаются владельцами behavior. New wiring receives recordUsage/emitFor callbacks, не импортирует turn component.

### Tools/catalog/skills/MCP

runtime-tool-catalog.ts — explicit register recipes и live skill/MCP/catalog rebuild state. build tools вызывается в прежней последовательности и existing registrars не переписываются. Args: exact dangerous/store/provider callbacks/approvals/shellJobs/read scopes. ShellJobRegistry lifetime принадлежит runtime, не registry; turn/delete/shutdown cleanup receives same instance.

MCP manager construction/sampling wiring и four-meta-tools-once остаются explicit phases. start() awaited в прежнем месте; refreshMcp only adds/removes dynamic projection, baseGrammar immutable. Config-gated descriptor cache fingerprint и fusion live descriptor behavior сохраняются. Skills seeding/registry refresh происходит раньше capability/store construction как сейчас; separate prepareSkills(...) и connectTools(...) сохраняют разнесённые boot phases. Нельзя promises/Promise.all запускать их раньше ради скорости.

### Memory

runtime-memory-stores.ts — ordered ProfileStore/MemoryStore/embedding health+attach/LinkStore/LessonStore/ProcedureStore/VoteStore recipes. Конструкции divided by phase if necessary: profile+notes, await embedding probe, derived stores; same startup order. Stores create even feature disabled as current. SessionStore separate owner.

runtime-memory-services.ts — reflection/evolution/link/vote decorators, memory context retrieval, query rewriter and consolidator construction; exact subcall callbacks/timeout/session identities/side slots/conditional deps and trace cold-path seq. Calls abortableSubcall with the same forwarded signals; don't capture active provider/tool transport prematurely. startConsolidator explicit old position, not constructor side effect. Consolidator currently independent scoped timer, not silently merged into Scheduler.

Borrowed vs owned: LinkStore, VoteStore, EmbeddingStore use notesStore DB handle and must not close it separately. Profile/Lesson/Procedure store each open own DB connection from dbFile (same file != same handle). Old ProcedureStore comment says shared handle despite actual own constructor: correct only verified owned prose, exact comment allowance. No migration/schema change. Constructors that throw before returning require exception safety at actual owner, not pretend root has a returned handle.

### Sessions/turns/task/channel resources

runtime-session-services.ts — SessionStore open/recover/retention + delete-wrapper installation, createSession/deferred/ephemeral helpers. Pins are read before TaskStore/WebhookSessionStore construction as current; do not move prune later or change stale recovery/persistence semantics.

runtime-turn-service.ts — existing executeTurn/runTurn/buildLoopTurnBudget/assertKnownProvider/nameSession/mark/release callbacks and turnRequests/inFlight lifecycle. Dependencies explicit loop, sessionStore, controller/inbox, tracing, live inference getters, shell jobs, shutdown flag getter. Keep actual algorithm bodies; AgentLoop/step executor untouched. Existing TurnController/SteeringInbox/TurnsInFlight remain independent owners, no new queue.

runtime-task-services.ts — TaskStore/WebhookSessionStore/recoverStale/TaskRunner/Scheduler construction and report-sink deferred channel lookup. createSession/runTurn injected only after created, no mutable global service lookup; task default limits/budgets/origin unchanged.

runtime-channels.ts — Telegram/Discord/Swarm construction, stable runtime reference, always constructed/deferred enabled start/status/approval routing + stop methods. Do not move token ownership into root or await fire-and-forget channel starts. Injection receives full runtime facade only here; phase makes façade identity stable without passing partially populated plain object into unrelated components.

runtime-lifecycle.ts — normal shutdown orchestration, shutdown flag and named resource handles/callbacks; existing failed-start limits documented below. This module receives phase-specific narrow stop/close callbacks, not runtime whole object or an arbitrary functions dictionary.

## 3. Startup, teardown и rollback: actual contract

Bootstrap currently has NO outer startup try/catch rollback. Resources allocated before a later factory rejects are not universally closed. Public shutdown exists only after loop/memory/tasks construction. Therefore copying shutdown into a generic LIFO disposer is neither preservation nor a complete startup rollback implementation.

### Mechanical part first

Move current normal shutdown with exact ordering, catches/log messages and flags:

1. Set shutdownCalled once; releaseOwnTurns keepMarks stand-in.
2. Start scheduler.stop() promise, catch/log; clear steering, endAll shell jobs, abort reflection and all pending naming controllers.
3. Await Telegram, then Discord, then Swarm stop, then MCP shutdown, then browser shutdown (current sequential awaits despite old Discord comment saying «alongside»).
4. settleCancelled(SHUTDOWN_TURN_GRACE_MS1500): one event loop trip, only already-aborted turn signals, bounded wait. Never wait for non-aborted scheduler/user turn indefinitely.
5. release interrupted turns again; close SessionStore, ProfileStore, LessonStore, ProcedureStore, NotesStore.
6. Await schedulerStopped, THEN consolidator.stop, THEN TaskStore.close, analytics.shutdown, errorReporter.shutdown.

Current order does NOT guarantee scheduler/consolidator work settles before all memory/session stores close. Preserve order in extraction; document this practical limit. A rule «stop all producers, await all, then close all stores» would be a separate behavioral change requiring evidence, not an implied reordering in06. shutdown concurrent callers currently second call returns immediately after flag, rather than sharing first completion promise; preserve observable semantics unless separate accepted defect fix.

Naming timer currently unref'd timeout and pending controller removed in finally; source doesn't clear timer after completed naming. Trace sink writes closeSync per event; no permanent trace DB/file handle to invent. Llama/OpenAI providers expose close, but current runtime shutdown does not iterate providers; OpenAI close is noop. ProviderRegistry has no closeAll, and fromConfig can fail before returning. Do not promise blanket provider closure without actual owner change.

### Существующая граница failed-start cleanup

Универсальный rollback не входит в механическую реорганизацию06. Новые компоненты должны явно назвать acquired/borrowed ресурсы и сохранить существующий cleanup там, где он уже есть; нельзя обещать закрытие объектов, которые factory не успела вернуть. Отсутствующий outer rollback, частичные provider factories и shutdown race фиксируются как existing limitations с отдельным behavioral follow-up при подтверждённом дефекте. Не добавлять provider-registry.closeAll или generic reverse-list попутно. Исправление failed-start cleanup потребовало бы отдельного concrete diff/fault tests и расширения scope; оно не является скрытым условием завершения06.

Process-wide installTransportDeadlines/installGlobalErrorHandlers не являются per-runtime reversible ресурсами: нельзя снимать чужой глобальный handler при cleanup одного runtime.

## 4. Turn, cancellation и hot-swap acceptance

runTurn rejects unknown pin BEFORE queue, then re-loads current session inside queued run callback; fallback to caller copy for never-persisted/deleted session stays. Same-session FIFO and cross-session concurrency untouched; signal abort while queued drops run without invocation. Sidecar owns controller.enqueue around mirror read/update and calls executeTurn inside already-held lock: preserve this seam, do not recursively enqueue it. Reuse sidecar/send-message-concurrency + send-message-steps + steering tests and actual main call sites; HTTP/TUI/channels continue public runTurn.

executeTurn plain vs ephemeral distinction, inFlight begin before marks/end after persistence; cancellation thrown turn release status and lastError restoration; cleanup turnRequests/context usage/trace pins/shell endTurn in finally. Completed finish closes all session shell jobs; normal reply endTurn preserves explicit kept jobs. Runtime steer uses inbox.push alone; isBusy pre-check forbidden. origin telemetry exclusion scheduler/fusion preserved.

ALS event routing per owning session, approvalRouter specific handler replacement/unsubscribe semantics; trace + live UI hook + fallback notices align. A fusion worker hook emits parent progress explicitly, not current ALS worker. Hook exceptions don't break FIFO. Pending reflection/naming outcomes can't leak into next session/hook; naming rereads store on return, first title wins, shutdown no late start/save.

Provider/model hot swap uses current registry/config/ModelProfileManager callbacks; profile+grammar+slot resizing together. Cloud boot skips local health/props; local link first turn/fallback lazily restores exactly once via DeferredLocalBackendProbes. Probe failure diagnostic shouldn't advance breaker; pinned worker errors unchanged; cancellation never fallback advance; servedTransport on chunks and completion matches actual serving link. Runtime reload config reset/merge/replace ordering, provider registry swaps/old close/listeners unchanged; no global freeze/captured bootstrap provider.

MCP live add/remove refresh changes AgentLoop grammar/catalog at next inference and invalidates stable prefix exactly when catalog changes. Local profile manager singleton warms configured URL, not per-fallback local endpoint: preserve known limitation, don't silently add manager cache. Per-model vision and strict/parallel capabilities follow served route. Existing rewriter fallback partition/session IDs and memory subcall response format intact.

## 5. Exact parallel write ownership

Shared integrator exclusively edits bootstrap.ts, lifecycle integration, public contract reexports, dependency checker policy, guides/plans/evidence and final frontend import migrations. No leaf agent edits shared root; each gets immutable snapshot and exact source ranges/allowed dependency API before work. Internal APIs named/typechecked before wiring; no any/as unknown casts/new type debt to bridge gaps.

Parallel wave1 (max available slots, integrator plus leaves):

- A runtime-contract.ts + runtime-observability.ts/runtime-traces.ts + adjacent tests.
- B runtime-local-profile.ts/runtime-inference.ts + adjacent tests; existing fallback modules untouched.
- C runtime-memory-stores.ts/runtime-memory-services.ts + adjacent tests; accepts injected inferred typed callbacks from approved seams, not root closure globals.

Parallel wave2 after wave1 APIs verified, SAME stage plan:

- A runtime-tool-catalog.ts + adjacent tests.
- B runtime-session-services.ts/runtime-turn-service.ts + adjacent tests.
- C runtime-task-services.ts/runtime-channels.ts + adjacent tests.

Integrator sequentially wires imports/call phases after each leaf ready; runtime-lifecycle.ts exact extraction and ownership documentation are integrator-owned, because they cross every acquired handle. New leaves import concrete internal seams/types, NEVER bootstrap/composition root or consumer frontend. Existing public types may depend type-only on domain resources, but concrete domain execution modules do not import runtime implementation. Avoid circular component imports: use narrow callback references with phase-specific assembly, not settable module globals.

No branch-per-microplan required. Parallel source extraction independent; global full suite once after integrated coherent result, no same-file concurrent edits or concurrent global caches/providers fixture conflicts.

## 6. Failure injection и meaningful tests

Existing evidence first: runtime/* including FIFO/steering/turns-in-flight/boot turn status/deferred/session retention/fusion/deferred local probes/fallback structured/rewriter tests; sidecar concurrency/steps/steer; HTTP route session SSE/cancel; Telegram/Discord/Swarm lifecycle; provider/model-profile-manager/slots/MCP registry replacement; trace recorder eviction; shell jobs/session persistence.

New tests focus ownership/cross-component failure seams:

- Typed operation log pins startup calls/probes order; cloud boot has no local HTTP; skipped feature stores still allocated/closed as existing; scheduler first tick only after primary channels assigned. Consolidator start current earlier placement preserved.
- Fault fixtures at existing cleanup boundaries: preserve original rejection and cleanup actually performed today; no close borrowed link/vote/embedding handle, unwired TDZ access or production network. Missing outer startup rollback documented explicitly, not asserted as implemented.
- Normal shutdown best-effort catches/order remains baseline even on cleanup failure. Internal test-only recipes/spies pin phase order; do not expand CreateAgentRuntimeOptions with debugging flags for every step.
- Scheduler tick/consolidator busy + aborted vs un-aborted turns: existing1500 bounded grace and session persisted cancelled/interrupted status; channels stop before session DB close, first interrupted stand-in can be replaced, second mark before close. Don't fake all work settled when current ordering doesn't guarantee it.
- Concurrent shutdown call observable semantics captured; existing failed-boot limitations explicitly observed; successful boot twice resource identities distinct except documented process globals.
- Deferred createSession no DB/trace before first prompt; workers no persistence/trace; delete mid-turn recorder pin until finally; stale queued state reload; same session errors don't poison FIFO, different sessions don't share events/approval handlers.
- Hot provider/model/MCP/skills/analytics changes AFTER construction observed by proper live getters only; explicitly preserve runtime.grammar snapshot versus loopDeps live grammar; verify cached descriptor gates/order/wire outputs.
- Abort subcall actually forwards signal and releases own slot, no late fallback breaker flip/usage after cancel. Pinned worker/direct already-locked turn don't recursively acquire same queue.

Use disposable ATOMIC_AGENT_STATE_DIR/workingDir, reset config/dynamic resource resolvers/registered provider kinds/global spies in finally; every actual store close awaited/verified; no personal state, GPU, real daemons/paid providers/live channel auth required. Existing external integration/eval limitations documented separately.

## 7. Proof, docs и конечные критерии

Mechanical source proof from immutable baseline reconstructs exact moved declaration/helper bodies/comments, root phases/literal/error/key ordering modulo approved identifiers and dependency argument substitutions; prove public contract types expand identically; non-owned agent/config/prompt/schema/tool/LLM algorithms byte-identical. Record correction of inaccurate owned comments independently. Поведенческие исправления вне mechanical scope не маскируются под exact move.

Runtime README maps public contract→composition root→component owner; lifecycle document names resource ownership/phases/current normal ordering and actual failed-start exclusions. Root agent instructions only route, no new repetitive nested instructions. Source comments linking old giant bootstrap sections point to actual owner; no docs claim full resource drain or dynamic grammar API beyond actual implementation.

Stage05 navigation routes приняты по обновлённым guides; повторять устаревшее hash-only описание нельзя. For06 demonstrate actual routes «add bootstrap tool integration», «change provider hot swap», «fix sidecar locked turn», «memory subcall cancellation», «shutdown channel/store race», each points contract/dependency recipe/lifecycle tests without full4319-line read. Don't declare measured productivity improvement without same-task comparison.

Checks: focused existing/new seams; lint; test types no new allowances (reduce genuine resolved debt only); imports zero runtime SCC/ownership exceptions and checker self-tests for edits; docs budgets/pointers/status; build; quarantine/self-tests; full test:ci once on final integration. Pin config/default/version/persisted JSON/tool catalog/wire schema/grammar/stable prefix outputs/protected files/package unchanged. Exact actual test counts, skips, exits and limitations saved in docs/testing/stage-06-validation.md. Fresh agent session route loading proof only if instructions altered; don't cite current session as loading evidence.

06 verified when public runtime contract compatible and isolated, composition order explicit, each allocated/borrowed resource has named owner and tested teardown matching actual code, existing failed-start limits documented, live state/cancel/FIFO/locked seams and full checks pass. Bootstrap may retain explicit root ordering/AgentLoop façade assembly; zero lines is not criterion. No requirement to repair every historical shutdown race/provider limitation as collateral. After verified only then specify stage07 agent cycle/policies/recovery/progress/public API work. План сохранён после verified05; stage07 специфицируется только после verified06.

## Решение о границе этапа

Рекомендация — механическое выделение явной сборки и ownership. Generic LIFO teardown и eager parallel construction отвергнуты: они меняют порядок использования stores/providers и могут закрыть borrowed SQLite handle. Универсальный failed-start rollback также исключён из этого переноса: его сейчас нет, поэтому добавление требует отдельной поведенческой задачи. Параллельность применяется к работе над независимыми owners, не к runtime startup.

## Приёмка

[Полная проверка06](../testing/stage-06-validation.md): public contract exact/type-compatible, actual facade/property descriptors/catalog/grammar byte-identical,42 root relocations и2435 остальных source files сохранены. Bootstrap4319→644 строк,13 construction owners; whole-boot isolation/failure/phase tests,1074 suites/12889passed/4existing skips, type debt848/no newerrors, lint/build/imports/docs passed. Граница failed-start/shutdown явно описана; rollback не добавлен. Следующий подробный07 создаётся только после этой приёмки.
