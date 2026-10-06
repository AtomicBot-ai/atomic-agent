import type { AtomicAgentConfig } from "../../config/config-schema.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { MemoryContextProvider } from "../../agent/agent-contract.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { TraceRecorder } from "../../tracing/trace/trace-recorder.js";
import type { TraceBus } from "../../tracing/trace/trace-bus.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import { createDefaultMemoryContextProvider } from "../../memory/memory-context-provider.js";
import { type RewriterLlmComplete, createQueryRewriterRunner, createRewriterAwareMemoryContextProvider, createAlwaysGate, createEmbeddingGate, createHeuristicGate, DEFAULT_REWRITER_EXEMPLARS, type RewriterGate } from "../../memory/retrieve/index.js";
import { createReflectionRunner, type ReflectionLlmComplete, type ReflectionRunner, type ReflectionTraceEvent } from "../../memory/reflection/index.js";
import { createLinkGeneratorRunner, createLinkAwareReflectionRunner, type LinkGeneratorLlmComplete, type LinkGeneratorTraceEvent } from "../../memory/links/index.js";
import { NeighborEvolver } from "../../memory/evolution/index.js";
import { ConsolidatorJob, DistillRunner } from "../../memory/consolidator/index.js";
import { createVoteRunner, createVoteAwareReflectionRunner, type VoteRunnerLlmComplete } from "../../memory/voting/index.js";
import { createVoteTraceSink, observeVoteRunnerHealth, type MemoryHealthAnnouncer } from "../announce-memory-health.js";
import { abortableSubcall, type SubcallComplete } from "../abortable-subcall.js";
import type { RuntimeMemoryStores } from "./runtime-memory-stores.js";

interface MemoryServiceDependencies extends Omit<RuntimeMemoryStores, "embeddingHealth"> {
  config: Pick<AtomicAgentConfig, "memory">;
  slotManager: Pick<SlotManager, "sideCallSlotId">;
  llmComplete: SubcallComplete;
  logger: StructuredLogger;
  metrics: AgentMetrics;
}

/** TurnContext/recorders and provider routing remain caller-owned live callbacks. */
export function createRuntimeMemoryServices(args: MemoryServiceDependencies & {
  toolTransport?: ToolCallTransport;
  touchRecorder: (sessionId: string) => TraceRecorder | undefined;
  memoryHealth: MemoryHealthAnnouncer;
}): { reflectionRunner: ReflectionRunner | undefined; memoryContextProvider: MemoryContextProvider | undefined } {
  const { config, slotManager, llmComplete, profileStore, notesStore, logger, metrics, linkStore, lessonStore, procedureStore, voteStore, embeddingClient, touchRecorder, memoryHealth } = args;


  // Memory-v2 phase 3. The neighbor-evolver writes parsed EVOLVE
  // directives back into `MemoryStore` after notes are stored.
  // Construction is unconditional but cheap; the runner is only
  // **wired into reflection** when the feature flag is on, so the
  // evolver itself is harmless when present-but-not-used.
  const neighborEvolver = config.memory.evolution.enabled
    ? new NeighborEvolver({
        memoryStore: notesStore,
        maxPerWrite: config.memory.evolution.maxPerWrite,
        leaseMs: config.memory.evolution.leaseMs,
        logger,
        metrics,
      })
    : undefined;

  const baseReflectionRunner = buildReflectionRunner({
    config,
    slotManager,
    llmComplete,
    toolTransport: args.toolTransport,
    profileStore,
    notesStore,
    logger,
    metrics,
    ...(neighborEvolver ? { neighborEvolver } : {}),
    // Per-session trace emission. The recorder map is keyed by
    // sessionId; reflection fires fire-and-forget after
    // `turn_finished`, so a missing recorder is a normal "tracing
    // disabled for this session" outcome, not an error.
    emitTrace: (event: ReflectionTraceEvent) => {
      touchRecorder(event.sessionId)?.recordReflection({
        outcome: event.outcome,
        ...(typeof event.factsWritten === "number"
          ? { factsWritten: event.factsWritten }
          : {}),
        ...(typeof event.notesWritten === "number"
          ? { notesWritten: event.notesWritten }
          : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
      // After the row, so a trace shows the outcome before the warning it
      // completed; outside the recorder check, so an untraced session is
      // still warned. Same in the link-generator and rewriter hooks.
      memoryHealth.observe(
        event.sessionId,
        "reflection",
        event.outcome,
        event.reason,
      );
    },
  });

  // Memory-v2 phase 2. Compose the base reflection runner with the
  // link-generator sub-call when the feature flag + auto-generation
  // are both on. The wrapper keeps the agent-loop call site
  // unchanged (it still calls `reflectionRunner.reflect(input)`); the
  // link-generator fires after the base runner returns, using
  // `input.recalledMemoryIds` as the allowlist.
  //
  // The link-generator rides the **same** `reflectionSlotId` as the
  // base reflection (cross-phase invariant 2). When the base runner
  // is absent (memory.reflection disabled), link-generation is also
  // skipped — we never want to spawn an LLM call just for the graph.
  let reflectionRunner: ReflectionRunner | undefined = baseReflectionRunner;
  if (
    baseReflectionRunner &&
    config.memory.links.enabled &&
    config.memory.links.autoGenerate
  ) {
    // Resolved per call: in managed mode the pool is one slot until the
    // first `/props`, so a reservation taken here would never exist.
    const reflectionSlotId = () => slotManager.sideCallSlotId();
    const linkGenLlmComplete: LinkGeneratorLlmComplete = abortableSubcall(
      llmComplete,
      (params: Parameters<LinkGeneratorLlmComplete>[0]) => ({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      }),
    );
    // Per-session trace emission — same resolve-by-sessionId pattern
    // as reflection / vote. Shared by the runner and the decorator:
    // the decorator's hydration-failure bail-out returns before
    // `generate()` is reached, so it is the only one that can report
    // that outcome, and it must land in the same stream under the
    // same event type or the trace still reads as "link-gen off".
    const emitLinkGeneratorTrace = (event: LinkGeneratorTraceEvent) => {
      touchRecorder(event.sessionId)?.recordLinkGenerator({
        outcome: event.outcome,
        ...(typeof event.linksWritten === "number"
          ? { linksWritten: event.linksWritten }
          : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
      memoryHealth.observe(
        event.sessionId,
        "link_generator",
        event.outcome,
        event.reason,
      );
    };
    const linkGenerator = createLinkGeneratorRunner({
      llmComplete: linkGenLlmComplete,
      linkStore,
      reflectionSlotId,
      timeoutMs: config.memory.links.generatorTimeoutMs,
      maxLinksPerCall: config.memory.links.maxLinksPerCall,
      minCandidates: config.memory.links.minCandidates,
      logger,
      metrics,
      emitTrace: emitLinkGeneratorTrace,
    });
    reflectionRunner = createLinkAwareReflectionRunner({
      reflection: baseReflectionRunner,
      linkGenerator,
      notesStore,
      minCandidates: config.memory.links.minCandidates,
      logger,
      emitTrace: emitLinkGeneratorTrace,
    });
  }

  // Memory-v2 phase 7a. Decorate the reflection runner with the
  // vote-runner sub-call so curation runs after `SET` / `NOTE` /
  // link-gen / `EVOLVE`. The decorator is fire-safe: a failed
  // vote-runner never breaks the reflection chain. Wiring only
  // proceeds when:
  //   - The base reflection chain is wired.
  //   - `memory.voting.enabled` (carries the VoteStore).
  // The vote-runner rides the **same** reflection slot as the
  // upstream chain (cross-phase invariant 2). Allowlist is
  // sourced from `ReflectionInput.{recalledIds, recalledLessonIds,
  // recalledProfileFactIds}` populated by `agent-loop.runTurn`
  // from `memory-context-provider` and `LessonStore.recall` —
  // anti-feedback-loop guardrail (invariant 18).
  if (reflectionRunner && voteStore) {
    const voteSlotId = () => slotManager.sideCallSlotId();
    const voteLlmComplete: VoteRunnerLlmComplete = abortableSubcall(
      llmComplete,
      (params: Parameters<VoteRunnerLlmComplete>[0]) => ({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      }),
    );
    // Memory-v2 phase 7a — one sink for both legs of voting: the
    // runner's per-vote rows and the decorator's run-level row. The
    // decorator's two bail-outs return before `run()` is reached, so
    // they are the only ones that can report those turns, and their
    // row has to land in the same stream or the trace still reads as
    // "voting off". Extracted (`createVoteTraceSink`) because nothing
    // could reach it from in here — see its own doc for which branch
    // folds health and why.
    const emitVoteTrace = createVoteTraceSink({
      resolveRecorder: touchRecorder,
      health: memoryHealth,
    });
    const voteRunner = createVoteRunner({
      llmComplete: voteLlmComplete,
      voteStore,
      reflectionSlotId: voteSlotId,
      timeoutMs: config.memory.reflection.timeoutMs,
      maxVotePerItem: config.memory.voting.maxVotePerItem,
      eventLogMaxRows: config.memory.voting.eventLogMaxRows,
      logger,
      metrics,
      emitTrace: emitVoteTrace,
    });
    reflectionRunner = createVoteAwareReflectionRunner({
      reflection: reflectionRunner,
      // The vote runner reports its outcome only in its result, so the
      // health check reads it there.
      voteRunner: observeVoteRunnerHealth(voteRunner, memoryHealth),
      memoryStore: notesStore,
      lessonStore,
      profileStore,
      procedureStore: config.memory.procedures.enabled ? procedureStore : null,
      logger,
      emitTrace: emitVoteTrace,
    });
  }

  // Read-side counterpart of reflection: pre-step recall injection and
  // memory-index pointer rendering. Wired only when `memory.notes` is
  // enabled — otherwise the runtime has nothing to read from and the
  // prompt tail skips both sections.
  const baseMemoryContextProvider = config.memory.notes.enabled
    ? createDefaultMemoryContextProvider({
        store: notesStore,
        recall: {
          enabled: config.memory.recallInjection.enabled,
          k: config.memory.recallInjection.k,
        },
        index: {
          enabled: config.memory.index.enabled,
          limit: config.memory.index.limit,
          previewChars: config.memory.index.previewChars,
        },
        // Memory-v2 phase 2: read-side BFS expansion. Falls back to a
        // no-op when the feature flag is off, so phase 1B callers stay
        // byte-identical.
        ...(config.memory.links.enabled
          ? {
              links: {
                enabled: true,
                store: linkStore,
                depth: config.memory.links.expansionDepth,
                maxExpanded: config.memory.links.maxExpanded,
              },
              metrics,
            }
          : {}),
        // Memory-v2 phase 5: surface lesson pointers in `### lessons`.
        // When `memory.lessons.enabled=false`, the provider skips the
        // call entirely and `recalledLessons` stays empty — the prompt
        // renderer then omits the section header.
        ...(config.memory.lessons.enabled
          ? {
              lessons: {
                enabled: true,
                store: lessonStore,
                k: config.memory.lessons.recallK,
              },
            }
          : {}),
        // Memory-v2 phase 7b. Surface advisory procedure pointers
        // in `### procedures`. Same gating story as lessons —
        // when disabled, the renderer omits the header.
        ...(config.memory.procedures.enabled
          ? {
              procedures: {
                enabled: true,
                store: procedureStore,
                k: config.memory.procedures.recallK,
              },
            }
          : {}),
      })
    : undefined;

  // v2.5 heuristic-gated query rewriter (Phase A, config v18).
  // When enabled, wrap the default provider with a decorator that
  // rewrites referential follow-ups via an LLM call on the reserved
  // reflection slot (`-1` while the pool has none to spare) before
  // delegating recall. Disabled-by-default contract: when the
  // flag is off, `memoryContextProvider` is byte-identical to the
  // pre-v18 chain.
  let memoryContextProvider = baseMemoryContextProvider;
  if (baseMemoryContextProvider && config.memory.retrieve.rewriter.enabled) {
    const rewriterLlmComplete: RewriterLlmComplete = abortableSubcall(
      llmComplete,
      (params: Parameters<RewriterLlmComplete>[0]) => ({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      }),
    );
    const rewriterCfg = config.memory.retrieve.rewriter;
    let gate: RewriterGate;
    if (rewriterCfg.gateMode === "embedding") {
      if (embeddingClient) {
        gate = createEmbeddingGate({
          embedder: embeddingClient,
          exemplars:
            rewriterCfg.embeddingGate.exemplars ?? DEFAULT_REWRITER_EXEMPLARS,
          threshold: rewriterCfg.embeddingGate.threshold,
          logger,
          metrics,
        });
      } else {
        logger.warn?.(
          "rewriter.gateMode=embedding but no embeddingClient — falling back to heuristic",
        );
        gate = createHeuristicGate();
      }
    } else if (rewriterCfg.gateMode === "always") {
      gate = createAlwaysGate();
    } else {
      gate = createHeuristicGate();
    }
    const rewriterRunner = createQueryRewriterRunner({
      llmComplete: rewriterLlmComplete,
      timeoutMs: rewriterCfg.timeoutMs,
      slotId: () => slotManager.sideCallSlotId(),
      gate,
      logger,
      metrics,
      // Per-session trace emission — the rewriter runs during
      // `refreshMemoryContext`, so the recorder for this session may
      // not exist yet on the very first turn; a missing recorder is a
      // normal "tracing disabled" outcome.
      emitTrace: (event) => {
        touchRecorder(event.sessionId)?.recordQueryRewriter({
          outcome: event.outcome,
          ...(event.reason ? { reason: event.reason } : {}),
        });
        memoryHealth.observe(
          event.sessionId,
          "rewriter",
          event.outcome,
          event.reason,
        );
      },
    });
    memoryContextProvider = createRewriterAwareMemoryContextProvider({
      inner: baseMemoryContextProvider,
      rewriter: rewriterRunner,
      historyTurns: config.memory.retrieve.rewriter.historyTurns,
    });
  }
  return { reflectionRunner, memoryContextProvider };
}

/** Construct only; bootstrap starts the returned job at the original explicit phase. */
export function createRuntimeMemoryConsolidator(args: Omit<MemoryServiceDependencies, "embeddingClient" | "profileStore"> & {
  traceBus: TraceBus | null;
}): ConsolidatorJob | null {
  const { config, slotManager, llmComplete, logger, metrics, traceBus, notesStore, linkStore, lessonStore, procedureStore, voteStore } = args;

  // `scheduler?.start()` is deliberately deferred until after the
  // Telegram channel object is constructed (near the end of bootstrap)
  // so a task report from the very first due tick can never observe a
  // missing channel — a not-yet-`up` channel queues reports itself.
  // The only cost is that overdue tasks fire their first tick a few
  // seconds later on a cold start; the tick cadence is unchanged.

  // Memory-v2 phase 5: cold-path consolidator. Owns its own
  // `setInterval` (scoped carve-out from "Scheduler is the only
  // periodic timer" invariant — analogous to the Telegram polling
  // carve-out). Started only when `memory.consolidation.enabled` is
  // true AND a reflection-slot llmComplete is available. Distillation
  // shares the reflection slot reserved above for link-generation;
  // when no slot was reserved (memory.reflection disabled or only one
  // llama-server slot) we fall back to slotId=-1 (no KV-cache reuse).
  let consolidatorJob: ConsolidatorJob | null = null;
  if (config.memory.lessons.enabled && config.memory.consolidation.enabled) {
    // One monotonic counter shared by every consolidator-origin trace
    // event (distill outcome + lesson/procedure deprecation) so the
    // synthetic `consolidator.ndjson` file stays totally ordered across
    // all event types within a tick. The consolidator does not run
    // through a per-session recorder, so we own the `seq` here.
    let consolidatorSeq = 0;
    // Piggy-back on the reflection slot for the distill call. The slot
    // is per-runtime, not per-job, and resolved per call — the slot
    // manager reserves once and returns the same id afterwards.
    const distillSlot = () => slotManager.sideCallSlotId();
    const distillLlmComplete: ReflectionLlmComplete = abortableSubcall(
      llmComplete,
      (params: Parameters<ReflectionLlmComplete>[0]) => ({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      }),
    );
    const distillRunner = new DistillRunner({
      llmComplete: distillLlmComplete,
      slotId: distillSlot,
      timeoutMs: config.memory.consolidation.distillTimeoutMs,
      logger,
      metrics,
      // Cold-path trace emission. The consolidator does not run through
      // a per-session recorder, so we emit straight onto the bus with
      // the synthetic `consolidator` sessionId and the shared cold-path
      // `seq`. No-op when tracing is disabled.
      ...(traceBus
        ? {
            emitTrace: (event) => {
              traceBus.emit({
                type: "distill",
                sessionId: "consolidator",
                seq: consolidatorSeq++,
                ts: Date.now(),
                outcome: event.outcome,
                ...(typeof event.clusterSize === "number"
                  ? { clusterSize: event.clusterSize }
                  : {}),
                ...(typeof event.hasProcedure === "boolean"
                  ? { hasProcedure: event.hasProcedure }
                  : {}),
                ...(event.reason ? { reason: event.reason } : {}),
              });
            },
          }
        : {}),
      // Memory-v2 phase 7b — emit a combined LESSON+PROCEDURE
      // response when procedures are enabled. The grammar still
      // permits the procedure half to be empty (conceptual
      // clusters), so this stays the safe default-on once the
      // feature is configured. Cross-phase invariant 21: this
      // does **not** add a second LLM call.
      withProcedure: config.memory.procedures.enabled,
    });
    consolidatorJob = new ConsolidatorJob(
      {
        enabled: true,
        intervalMs: config.memory.consolidation.intervalMs,
        cooldownMs: config.memory.consolidation.cooldownMs,
        minClusterSize: config.memory.consolidation.minClusterSize,
        maxClustersPerTick: config.memory.consolidation.maxClustersPerTick,
        requireSharedTag: config.memory.consolidation.requireSharedTag,
        consolidationLeaseMs: 60_000,
        // Memory-v2 phase 6 — wire the age-based deprecation
        // threshold and the per-tick deprecation cap. Both come
        // from `memory.lessons.*` since they govern lesson rows.
        // `maxEntries` is held inside the `LessonStore` itself
        // (already passed via `LessonStoreOptions`) and surfaces
        // through `pickOverflowForDeprecation()`.
        deprecationAgeMs: config.memory.lessons.deprecationAgeMs,
        maxDeprecationsPerTick: 100,
        // Memory-v2 phase 7a — vote-driven decay runs once per
        // tick (cross-phase invariant 23). `0` here disables both
        // the decay pass and the vote-driven deprecation sweep
        // even if the `voteStore` dep is present, so the master
        // switch is honoured without re-checking `enabled` deep
        // inside the job.
        voteSignalDecay: config.memory.voting.enabled
          ? config.memory.voting.signalDecay
          : 0,
        // Memory-v2 phase 7b — procedure age threshold and cascade
        // hook live behind the procedures master switch.
        ...(config.memory.procedures.enabled
          ? {
              procedureDeprecationAgeMs:
                config.memory.procedures.deprecationAgeMs,
            }
          : {}),
      },
      {
        memoryStore: notesStore,
        linkStore,
        lessonStore,
        distillRunner,
        metrics,
        logger,
        ...(config.memory.procedures.enabled ? { procedureStore } : {}),
        ...(voteStore ? { voteStore } : {}),
        // Memory-v2 phase 6. Bridge the sweep's per-lesson demotion
        // callback to the trace bus. The consolidator runs
        // out-of-band so we use the synthetic `consolidator`
        // session id (matching the one the DistillRunner uses).
        // The bus fans out to the NDJSON sink which writes to
        // `<stateDir>/traces/consolidator.ndjson` — a dedicated
        // cold-path log keyed by sessionId. A local `seq` counter
        // keeps the file monotonically ordered; per-session
        // counters are recorder-owned, but the consolidator does
        // not run through a recorder.
        ...(traceBus
          ? ((): {
              onLessonDeprecated: (event: {
                lessonId: number;
                reason: string;
              }) => void;
              onProcedureCreated?: (event: {
                procedureId: number;
                parentLessonIds: readonly number[];
                parentMemoryIds: readonly number[];
                source: "consolidator" | "manual";
              }) => void;
              onProcedureDeprecated?: (event: {
                procedureId: number;
                reason: string;
              }) => void;
            } => {
              // Shares the hoisted `consolidatorSeq` declared above so
              // distill + lesson/procedure events stay ordered in the
              // same cold-path NDJSON file.
              return {
                onLessonDeprecated: ({ lessonId, reason }) =>
                  traceBus.emit({
                    type: "lesson_deprecated",
                    sessionId: "consolidator",
                    seq: consolidatorSeq++,
                    ts: Date.now(),
                    lessonId,
                    reason,
                  }),
                ...(config.memory.procedures.enabled
                  ? {
                      onProcedureCreated: ({
                        procedureId,
                        parentLessonIds,
                        parentMemoryIds,
                        source,
                      }) =>
                        traceBus.emit({
                          type: "procedure_created",
                          sessionId: "consolidator",
                          seq: consolidatorSeq++,
                          ts: Date.now(),
                          procedureId,
                          parentLessonIds: [...parentLessonIds],
                          parentMemoryIds: [...parentMemoryIds],
                          source,
                        }),
                      onProcedureDeprecated: ({ procedureId, reason }) =>
                        traceBus.emit({
                          type: "procedure_deprecated",
                          sessionId: "consolidator",
                          seq: consolidatorSeq++,
                          ts: Date.now(),
                          procedureId,
                          reason,
                        }),
                    }
                  : {}),
              };
            })()
          : {}),
      },
    );
  }
  return consolidatorJob;
}


/**
 * Instantiate the async end-of-turn reflection runner when memory +
 * reflection are enabled in config. Reserves a dedicated slot from the
 * shared `SlotManager` so the main agent's KV cache is never evicted by
 * a reflection call. Falls back to `slotId: -1` (no slot affinity) when
 * the llama-server is configured with only one slot — reflection still
 * runs, it just doesn't get its own prefix cache reuse.
 *
 * Returns `undefined` (wiring skipped) when either memory layer is
 * disabled — the AgentLoop then behaves exactly as before the
 * reflection feature was introduced.
 */
function buildReflectionRunner(args: {
  config: Pick<AtomicAgentConfig, "memory">;
  slotManager: Pick<SlotManager, "sideCallSlotId">;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  toolTransport?: import("../../llm/provider/completion-types.js").ToolCallTransport;
  profileStore: ProfileStore;
  /**
   * Freeform notes store. Wired only when both `memory.notes.enabled`
   * and `memory.reflection.autoStoreNotes` are true — otherwise the
   * runner falls back to profile-only extraction and the NOTE channel
   * is silently dropped.
   */
  notesStore: MemoryStore;
  /** Memory-v2 phase 3. Optional; when omitted EVOLVE is dropped. */
  neighborEvolver?: NeighborEvolver;
  /**
   * Optional per-call trace sink. Bootstrap resolves the per-session
   * `TraceRecorder` by `event.sessionId` and forwards to
   * `recordReflection`.
   */
  emitTrace?: (event: ReflectionTraceEvent) => void;
  logger: StructuredLogger;
  metrics: AgentMetrics;
}): ReflectionRunner | undefined {
  const memory = args.config.memory;
  if (!memory.profile.enabled || !memory.reflection.enabled) return undefined;
  // Resolved per call rather than reserved here: a managed daemon's
  // slot count is not known at boot (the pool is one slot until the
  // first `/props`), and a reservation taken now would be `-1` forever
  // — every reflection call would then let llama-server pick any idle
  // slot, the main loop's included.
  const reflectionSlotId = () => args.slotManager.sideCallSlotId();
  const reflectionLlmComplete: ReflectionLlmComplete = abortableSubcall(
    args.llmComplete,
    ({ signal: _signal, ...rest }: Parameters<ReflectionLlmComplete>[0]) =>
      rest,
  );
  const notesWriteEnabled =
    memory.notes.enabled &&
    memory.reflection.autoStoreNotes &&
    memory.reflection.maxNotesPerCall > 0;
  return createReflectionRunner({
    llmComplete: reflectionLlmComplete,
    ...(args.toolTransport ? { toolTransport: args.toolTransport } : {}),
    profileStore: args.profileStore,
    ...(notesWriteEnabled ? { memoryStore: args.notesStore } : {}),
    ...(args.neighborEvolver ? { neighborEvolver: args.neighborEvolver } : {}),
    ...(args.emitTrace ? { emitTrace: args.emitTrace } : {}),
    reflectionSlotId,
    timeoutMs: memory.reflection.timeoutMs,
    maxFactsPerCall: memory.reflection.maxFactsPerCall,
    maxNotesPerCall: notesWriteEnabled ? memory.reflection.maxNotesPerCall : 0,
    // v2.5 typed-NOTE extraction (Phase C). Threaded as a
    // boolean dep so the runner can pick the typed reflection prefix
    // and the parser can project [type=X] into the `type:<X>` tag.
    typedNotes: memory.reflection.typedNotes.enabled,
    // Multi-party reflection mode (config v19). When enabled, the
    // runner switches to REFLECTION_STABLE_PREFIX_ANY_SPEAKER so
    // third-party speakers in the USER channel become valid
    // extraction sources. Wins over `typedNotes`.
    anySpeaker: memory.reflection.anySpeaker,
    logger: args.logger,
    metrics: args.metrics,
  });
}
