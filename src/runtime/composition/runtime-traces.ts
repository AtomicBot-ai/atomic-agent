import { AsyncLocalStorage } from "node:async_hooks";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import {
  contextUsageFromPrompt,
  type ContextUsageState,
  type SessionState,
} from "../../session/index.js";
import type { TurnController } from "../turn-controller.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import {
  createNdjsonTraceSink,
  createTraceBus,
  createTraceRecorder,
  type TraceBus,
  type TraceRecorder,
  type TraceSink,
} from "../../tracing/trace/index.js";
import { captureError, type SentryClient } from "../../error-reporting/index.js";

export function createRuntimeTraces(
  config: AtomicAgentConfig,
  options: Pick<CreateAgentRuntimeOptions, "traceDefault" | "handlers">,
  logger: StructuredLogger,
) {

  const traceEnabled = resolveTraceEnabled(
    config.tracing.trace.enabled,
    options.traceDefault,
  );
  const traceBus = traceEnabled
    ? buildTraceBus({
        extraSinks: options.handlers?.traceSinks ?? [],
        dir: config.tracing.trace.dir,
        maxBytesPerSession: config.tracing.trace.maxBytesPerSession,
        logger,
      })
    : null;
  /**
   * Trace recorders keyed by session id, bounded so a long-lived runtime
   * that serves many sessions (sidecar, HTTP server, background tasks)
   * cannot grow this map without limit.
   *
   * `Map` preserves *insertion* order, which is not the same as recency:
   * re-reading a key does not move it. Evicting `keys().next()` therefore
   * targets the oldest-*created* session, which in a long-lived runtime is
   * usually the operator's own still-running one. `touchRecorder` re-inserts
   * on every access so the order really is least-recently-used, and
   * `dropRecorder` removes a session's recorder when the session itself goes
   * away — cheaper and more correct than waiting for the cap to push it out.
   *
   * Eviction is not free: `beginSession` is written to run once per NDJSON
   * file, so re-creating an evicted recorder appends a second
   * `session_started` and restarts `seq` at 0 in a file that already has
   * events. Anything sorting or de-duplicating by `seq` then mis-orders.
   * That is why an actively-running session is never evicted.
   */
  const MAX_TRACE_RECORDERS = 64;
  const recorders = new Map<string, TraceRecorder>();
  /** Sessions with a turn in flight. Never evicted; see `evictRecorders`. */
  const activeTraceSessions = new Set<string>();

  /** Look a recorder up and mark it most-recently-used. */
  const touchRecorder = (sessionId: string): TraceRecorder | undefined => {
    const recorder = recorders.get(sessionId);
    if (recorder !== undefined) {
      recorders.delete(sessionId);
      recorders.set(sessionId, recorder);
    }
    return recorder;
  };

  /** Sessions deleted mid-turn, to be dropped once their turn releases. */
  const pendingRecorderDrops = new Set<string>();

  /**
   * Forget a session's recorder once the session is gone.
   *
   * A delete that lands mid-turn must not unpin the running turn: the HTTP
   * route deletes without an `isBusy` check (unlike the TUI, which refuses),
   * and dropping the pin there would let the next burst evict a recorder the
   * turn is still writing through — reintroducing the split trace file this
   * pinning exists to prevent. Such a delete is deferred instead, and the
   * turn's `finally` completes it; leaving it to cap pressure would strand the
   * recorder of a session that no longer exists until 64 more arrive.
   */
  const dropRecorder = (sessionId: string): void => {
    if (activeTraceSessions.has(sessionId)) {
      pendingRecorderDrops.add(sessionId);
      return;
    }
    pendingRecorderDrops.delete(sessionId);
    recorders.delete(sessionId);
  };

  /**
   * Trim to the cap, least-recently-used first, skipping sessions with a live
   * turn and `exempt` (the entry the caller just created — it has not had a
   * chance to be pinned yet, and evicting it would throw away the recorder
   * whose creation triggered this call).
   *
   * If everything is pinned the map is allowed over the cap: losing a running
   * session's trace is worse than holding a few extra recorders, and the
   * excess drains as those turns finish and release their pins.
   */
  const evictRecorders = (exempt?: string): void => {
    if (recorders.size <= MAX_TRACE_RECORDERS) return;
    for (const sessionId of [...recorders.keys()]) {
      if (recorders.size <= MAX_TRACE_RECORDERS) break;
      if (sessionId === exempt) continue;
      if (activeTraceSessions.has(sessionId)) continue;
      recorders.delete(sessionId);
    }
  };
  /**
   * Per-turn context used to route `loopDeps.onEvent` calls back to
   * the correct session. Two sessions running concurrently each have
   * their own `AsyncLocalStorage` frame, so the `loopDeps.onEvent`
   * closure can look up the right recorder without a process-global
   * pointer.
   */
  const turnContext = new AsyncLocalStorage<{ sessionId: string }>();
  /**
   * The running turn's window occupancy, per session. Written by
   * `emitAgentLoopEvent` (`prompt_built`, refined by `llm_completed`),
   * consumed once by `executeTurn` when it stamps the finished session,
   * and always cleared in its `finally` so an aborted turn cannot leak
   * an entry — or bleed one turn's gauge into a session that never
   * built a prompt of its own.
   */
  const lastTurnContextUsage = new Map<string, ContextUsageState>();

  const ensureRecorder = (
    session: SessionState,
    /** Current turn stamps for a newly opened trace header. */
    headerMetadata?: Record<string, unknown>,
  ): TraceRecorder | null => {
    if (!traceBus) return null;
    const existing = touchRecorder(session.id);
    if (existing) return existing;
    const recorder = createTraceRecorder({
      sessionId: session.id,
      emit: (event) => traceBus.emit(event),
    });
    const metadata = headerMetadata ?? session.metadata;
    recorder.beginSession({
      workingDir: session.workingDir,
      ...(metadata ? { metadata } : {}),
    });
    recorders.set(session.id, recorder);
    // Exempt the entry just created: the caller pins it only after this
    // returns, so without this it is the sole unpinned entry when every other
    // session is mid-turn and would evict itself — losing the whole turn's
    // trace to a file that already has its `session_started` line.
    evictRecorders(session.id);
    return recorder;
  };

  const pinSession = (sessionId: string): void => {
    activeTraceSessions.add(sessionId);
  };
  const readContextUsage = (sessionId: string): ContextUsageState | undefined =>
    lastTurnContextUsage.get(sessionId);
  const clearContextUsage = (sessionId: string): void => {
    lastTurnContextUsage.delete(sessionId);
  };
  const releaseSession = (sessionId: string): void => {
    activeTraceSessions.delete(sessionId);
    // A delete that arrived mid-turn was deferred to keep the pin honest;
    // complete it now that nothing is writing through the recorder.
    if (pendingRecorderDrops.has(sessionId)) {
      pendingRecorderDrops.delete(sessionId);
      recorders.delete(sessionId);
    }
    // The turn may have out-waited a burst that could not evict while it
    // was pinned; settle the map now that it can.
    evictRecorders();
  };

  const createEventRouting = (
    turnController: Pick<TurnController, "emit">,
    options: Pick<CreateAgentRuntimeOptions, "handlers">,
    getErrorReporter: () => SentryClient | null,
  ) => {

    /**
     * Single fan-out for `AgentLoopEvent`s. The loop's own `onEvent`
     * closure (built later) routes through here, and so does the provider
     * fallback chain's notice sink — a `provider_switched` event surfaces
     * exactly like any other loop event (trace recorder, TUI/HTTP/sidecar
     * event streams, host handler).
     *
     * The session is a PARAMETER, not a read of the ambient ALS frame:
     * `emitAgentLoopEvent` below supplies it from the frame for every
     * ordinary caller, while the fusion fan-out supplies the parent's id
     * explicitly from inside a worker's frame. Either way the id is what
     * keeps two concurrent sessions from cross-contaminating.
     */
    const emitAgentLoopEventFor = (
      sessionId: string | undefined,
      event: AgentLoopEvent,
    ): void => {
      const ctx = sessionId === undefined ? undefined : { sessionId };
      if (ctx) {
        const recorder = touchRecorder(ctx.sessionId);
        recorder?.onAgentEvent(event);
        turnController.emit(ctx.sessionId, event);
        // Track the turn's window occupancy so `executeTurn` can stamp it
        // onto the session before the post-turn save. Mirrors the TUI's own
        // reduction: the `prompt_built` estimate, refined by the provider's
        // real tokenizer count when the completion reports one.
        if (event.type === "llm_event") {
          const step = event.event;
          if (step.type === "prompt_built") {
            lastTurnContextUsage.set(
              ctx.sessionId,
              contextUsageFromPrompt(step.prompt),
            );
          } else if (step.type === "llm_completed") {
            const counted = step.completion.timing?.promptTokens ?? 0;
            const usage = lastTurnContextUsage.get(ctx.sessionId);
            if (counted > 0 && usage) {
              lastTurnContextUsage.set(ctx.sessionId, {
                ...usage,
                tokens: counted,
              });
            }
          }
        }
      }
      if (event.type === "loop_failed") {
        captureError(getErrorReporter(), event.error, {
          source: "llm_failure",
          category: event.category,
        });
      }
      options.handlers?.onAgentEvent?.(event, ctx?.sessionId);
    };

    /**
     * The ALS-resolving form every in-turn caller uses. Split from
     * `emitAgentLoopEventFor` for one caller that cannot use it:
     * `fusion.delegate` emits its worker progress from inside a worker
     * turn's event hook, which runs under the WORKER's ALS frame, and
     * those events belong to the parent — the worker session has no
     * recorder, no hook and no UI, so an event tagged with its id reaches
     * nobody at all.
     */
    const emitAgentLoopEvent = (event: AgentLoopEvent): void => {
      emitAgentLoopEventFor(turnContext.getStore()?.sessionId, event);
    };
    return { emitAgentLoopEventFor, emitAgentLoopEvent };
  };

  return {
    traceBus,
    turnContext,
    touchRecorder,
    dropRecorder,
    ensureRecorder,
    pinSession,
    readContextUsage,
    clearContextUsage,
    releaseSession,
    createEventRouting,
  };
}


/**
 * Resolve the effective trace toggle. The config value wins when explicit
 * (`true` / `false`); otherwise the entry-point default decides (CLI is
 * `true`, sidecar is `false`, absent defaults to `false`).
 */
function resolveTraceEnabled(
  fromConfig: boolean | null,
  fromEntryPoint: boolean | undefined,
): boolean {
  if (fromConfig !== null) return fromConfig;
  return fromEntryPoint ?? false;
}


/**
 * Wire trace sinks into a fan-out bus. Always includes the on-disk
 * NDJSON sink so `atomic-agent trace show` can read the session back —
 * callers append additional sinks (sidecar relay, sentry, …) via
 * `handlers.traceSinks`.
 */
function buildTraceBus(args: {
  extraSinks: TraceSink[];
  dir: string;
  maxBytesPerSession: number;
  logger: StructuredLogger;
}): TraceBus {
  const ndjsonSink = createNdjsonTraceSink({
    dir: args.dir,
    maxBytesPerSession: args.maxBytesPerSession,
    logger: args.logger,
  });
  return createTraceBus([ndjsonSink, ...args.extraSinks]);
}
