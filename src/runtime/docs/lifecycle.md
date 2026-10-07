# Turn ownership and runtime lifecycle

Status: current
Owner: src/runtime/

## Turns and hooks

TurnController serializes turns on the same session and permits independent sessions concurrently. It installs the owning event hook before the body runs and clears it in cleanup. ApprovalRouter similarly prefers a per-session handler. Do not replace either with a mutable selected-chat global.

Public runTurn enqueues; executeTurn is for a caller that already holds the lock, notably sidecar integration. Nesting the queue inside itself deadlocks. Shared browser/backend resources remain shared even though sessions are independent.

Steering enters a running turn at its next checkpoint. A false return means the message was not accepted; each ingress must apply its documented queue/new-turn policy rather than drop it. Query isBusy is not an atomic steering acceptance test.

## Resources

Bootstrap owns provider/slot wiring, stores, tool registration, background jobs and channels. Preserve live getters for provider/model/tool changes. Reflection and other sub-calls use separate slot/provider posture; workers are ephemeral, non-persistent and cannot wait for invisible interactive approval.

[Composition recipes](../composition/README.md) create resources at explicit bootstrap phases; [runtime-lifecycle.ts](../composition/runtime-lifecycle.ts) owns the normal shutdown flag and sequence. ProfileStore, MemoryStore (notes), LessonStore and ProcedureStore each own their SQLite connection, even where they use the same file. LinkStore, VoteStore and the embedding index borrow notesStore's connection and are not separately closed. SessionStore and TaskStore own their respective connections; WebhookSessionStore persists JSON and has no closeable database handle. ShellJobRegistry is shared by delete, turn cleanup and shutdown. Trace recorders open/close synchronously per write; trace maps/pins belong to the trace component.

Channel shutdown handles and scheduled/background handles are supplied as late getters because their construction occurs after lifecycle assembly. Catalog and serving-provider callbacks are also live; public runtime.grammar and boot config are snapshots. Process-wide transport deadlines/error handlers are explicit bootstrap actions and must not be removed by one runtime's shutdown. ProviderRegistry currently has no shutdown iteration; no blanket provider-close guarantee is implied.

Shutdown first records interrupted turns, starts bounded stops of the task runner and scheduler, clears steering/shell jobs and aborts reflection and naming. It then stops channels and MCP/browser, gives cancelled turns a bounded chance to record their end, and closes session/profile/lesson/procedure/note stores. It awaits the bounded task/scheduler stops and stops the consolidator before closing the task store and flushing telemetry. This is the current ordering, not a guarantee that every background task settles before every store closes. Preserve the shutdown tests and interrupted-turn persistence; changing that order belongs to a runtime change, not a documentation move. Scheduler/consolidation/channel polling are scoped lifecycle exceptions; they do not justify unrelated timers.

At bootstrap, interrupted task claims are recovered by recorded process ownership before scheduler start, with age fallback for legacy rows; live owners are left alone. A failed sweep is warned without blocking bootstrap. At shutdown, TaskRunner cancels every owned run and prevents new claims; scheduler stops its ingress and aborts its current drain. Both stop waits receive the 1500 ms turn grace. A run ignoring cancellation stays recorded for the next process to recover.

Channel stops are awaited sequentially: Telegram → Discord → Swarm → MCP → browser. The cancelled-turn grace period is 1500 ms and waits only for already-aborted turns. A concurrent second shutdown returns after observing the flag; it does not share the first caller's completion promise. Naming's timeout remains unref'd and is not cleared after early completion. These are existing behaviors, not stronger drain guarantees.

## Failed startup

There is no outer startup try/catch rollback. A factory failure can leave resources acquired by earlier phases open, and a constructor that fails before returning cannot provide a handle for root cleanup. Individual owners retain their existing local cleanup only. Generic reverse-order teardown would both change normal ordering and risk closing borrowed handles; universal rollback and scheduler/consolidator store races require separate behavioral work with fault tests.

## Sources and tests

- [Assembly](../bootstrap.ts), [shutdown](../composition/runtime-lifecycle.ts), [FIFO](../turn-controller.ts), [steering](../steering-inbox.ts), [approval routing](../../approval/approval-router.ts).
- [FIFO tests](../turn-controller.test.ts), [steering tests](../steering-inbox.test.ts), [shutdown tests](../bootstrap.test.ts), [worker wiring](../bootstrap-fusion-seams.test.ts).
