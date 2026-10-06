import type { AtomicAgentConfig } from "../../config/index.js";
import { getConfig } from "../../config/index.js";
import type { AgentLoop } from "../../agent/agent-loop.js";
import type { RunTurnResult } from "../../agent/agent-contract.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ReasoningEffort } from "../../llm/provider/completion-types.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { ProviderRegistry } from "../../llm/provider/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { ProviderFallbackChain } from "../../llm/fallback/index.js";
import type { SessionStore } from "../../session/session-store.js";
import { readFusionWorkerMeta, SESSION_LLM_METADATA_KEY, SESSION_ROUTE_METADATA_KEY, readSessionRoute, resolveTurnRoute, SESSION_TITLE_METADATA_KEY, SESSION_TITLE_TIMEOUT_MS, generateSessionTitle, readSessionTitle, shouldNameSession, type SessionLlmStamp, type SessionState } from "../../session/index.js";
import { renderRouteChangeNote } from "../../prompt/route-change-note.js";
import { pickOriginalRequest } from "../../tools/fusion/index.js";
import type { ToolRole } from "../../tools/tool-roles.js";
import type { ShellJobRegistry } from "../../tools/os/shell/shell-jobs.js";
import { captureMessageSent, type AnalyticsStateStore, type TurnUsageMeter } from "../../analytics/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { TurnController, TurnEventHook, TurnOrigin } from "../turn-controller.js";
import type { SteeringInbox } from "../steering-inbox.js";
import { TurnsInFlight } from "../turns-in-flight.js";
import type { createRuntimeTraces } from "./runtime-traces.js";
import type { createRuntimeObservability } from "./runtime-observability.js";
import type { RuntimeProviders } from "./runtime-inference.js";

export function prepareRuntimeTurnState() {
  /**
   * In-flight session-naming calls, so teardown can cut them.
   *
   * `nameSession` is fired as a bare `void` at the end of a turn and
   * only reads and writes the session store once its completion comes
   * back — up to `SESSION_TITLE_TIMEOUT_MS` later. `shutdown` closes
   * that store, so a call still in flight is the reflection race again:
   * aborting here settles the completion instead of leaving a side-call
   * slot and an HTTP read outstanding while the runtime goes away.
   *
   * The abort is not what keeps the store write safe — an abort a
   * provider ignores would still let the continuation run. That is
   * `shutdownCalled`'s job, checked on both sides of the completion.
   */
  const pendingSessionNamings = new Set<AbortController>();
  /**
   * The turns `executeTurn` is running, so `shutdown` can let the ones
   * their hosts stopped write their own end before the session store
   * closes (`TurnsInFlight`).
   */
  const turnsInFlight = new TurnsInFlight();

  return { pendingSessionNamings, turnsInFlight };
}

export type RuntimeTurnState = ReturnType<typeof prepareRuntimeTurnState>;

type RuntimeTraces = ReturnType<typeof createRuntimeTraces>;

export interface RuntimeTurnDependencies {
  sessions: {
    sessionStore: Pick<SessionStore, "save" | "load" | "beginTurn" | "releaseTurn" | "finishTurn">;
    turnContext: RuntimeTraces["turnContext"];
    turnRequests: Map<string, string>;
  };
  execution: {
    loop: Pick<AgentLoop, "runTurn">;
    turnController: Pick<TurnController, "enqueue">;
    steeringInbox: Pick<SteeringInbox, "push">;
    shellJobs: Pick<ShellJobRegistry, "endSession" | "endTurn">;
    slotManager: Pick<SlotManager, "sideCallSlotId">;
    llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  };
  inference: {
    providerRegistry: Pick<ProviderRegistry, "getProvider" | "activeText">;
    resolveActiveLlmSlice: RuntimeProviders["resolveActiveLlmSlice"];
    resolveCurrentRunMode: RuntimeProviders["resolveCurrentRunMode"];
    resolveRouteVision: RuntimeProviders["resolveRouteVision"];
    resolveActiveModelName: RuntimeProviders["resolveActiveModelName"];
    fallbackChain: Pick<ProviderFallbackChain, "standingOverrideFor">;
  };
  traces: Pick<RuntimeTraces, "ensureRecorder" | "pinSession" | "readContextUsage" | "clearContextUsage" | "releaseSession">;
  telemetry: {
    observability: Pick<ReturnType<typeof createRuntimeObservability>, "getAnalytics">;
    analyticsStateStore: AnalyticsStateStore;
    turnUsageMeter: TurnUsageMeter;
  };
  state: RuntimeTurnState;
  lifecycle: { isShutdown(): boolean };
  logger: StructuredLogger;
}

export function createRuntimeTurnService(
  config: AtomicAgentConfig,
  deps: RuntimeTurnDependencies,
) {
  const { sessionStore, turnContext, turnRequests } = deps.sessions;
  const { loop, turnController, steeringInbox, shellJobs, slotManager, llmComplete } = deps.execution;
  const { providerRegistry, resolveActiveLlmSlice, resolveCurrentRunMode, resolveRouteVision, resolveActiveModelName, fallbackChain } = deps.inference;
  const { traces, lifecycle, logger } = deps;
  const { ensureRecorder } = traces;
  const { observability, analyticsStateStore, turnUsageMeter } = deps.telemetry;
  const { pendingSessionNamings, turnsInFlight } = deps.state;
  /**
   * The loop-side budget for one turn. An explicit `maxSteps` from a
   * caller (a durable task that pins its own budget, `run --max-steps`)
   * is a *ceiling* that caller chose — honour it as one. Absent that,
   * the config value is the leg length and `agent.task.*` supplies the
   * ceiling, so an ordinary turn runs the task to completion instead of
   * stopping at the first checkpoint. The provider pin and the duration
   * ceiling ride along unchanged.
   */
  const buildLoopTurnBudget = (runOptions: {
    maxSteps?: number;
    signal?: AbortSignal;
    providerId?: string;
    taskMaxDurationMs?: number;
    toolFilter?: (name: string) => boolean;
    toolRole?: ToolRole;
    reasoningEffort?: ReasoningEffort;
    maxOutputTokens?: number;
  }) => ({
    ...(runOptions.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: runOptions.reasoningEffort }),
    ...(runOptions.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: runOptions.maxOutputTokens }),
    maxSteps: Math.min(
      config.agent.maxSteps,
      runOptions.maxSteps ?? config.agent.maxSteps,
    ),
    ...(runOptions.maxSteps === undefined
      ? {}
      : { taskMaxSteps: runOptions.maxSteps }),
    ...(runOptions.taskMaxDurationMs === undefined
      ? {}
      : { taskMaxDurationMs: runOptions.taskMaxDurationMs }),
    ...(runOptions.providerId === undefined
      ? {}
      : { providerId: runOptions.providerId }),
    ...(runOptions.toolFilter === undefined
      ? {}
      : { toolFilter: runOptions.toolFilter }),
    ...(runOptions.toolRole === undefined
      ? {}
      : { toolRole: runOptions.toolRole }),
    signal: runOptions.signal ?? new AbortController().signal,
  });

  /**
   * A pinned turn must land on the provider it names. The registry is
   * the authority; an id it does not hold would otherwise degrade to the
   * active provider inside `resolveActiveLlmSlice` — for a fusion worker
   * that means silently running on the cloud leg.
   */
  const assertKnownProvider = (providerId: string | undefined): void => {
    if (providerId === undefined) return;
    if (!providerRegistry.getProvider(providerId)) {
      throw new Error(
        `cannot pin turn to llm provider "${providerId}": not configured`,
      );
    }
  };

  /**
   * Ask the model for a short name and store it on the session.
   *
   * Re-reads and re-saves through the store rather than writing the
   * `finished` object it was handed: the call takes a second or two and
   * the next turn may already have saved over it, so the read-modify-
   * write has to happen when the answer arrives, not before.
   */
  const nameSession = async (state: SessionState): Promise<void> => {
    // A turn can finish *during* teardown — `shutdown` aborts the set
    // below and then awaits channel/MCP/browser teardown before the
    // stores close, and a turn completing in that window would register
    // a fresh controller into a set nothing will visit again. Naming a
    // session a quit is already discarding buys nothing, so don't start.
    if (lifecycle.isShutdown()) return;
    // Its own deadline: the turn is over, nothing is waiting on this,
    // and a naming call that hangs must not hold a slot for the next
    // turn to queue behind.
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(),
      SESSION_TITLE_TIMEOUT_MS,
    ).unref?.();
    void timer;
    // Teardown's handle on this call, dropped again below so a quit
    // after the call has settled aborts nothing.
    pendingSessionNamings.add(abort);
    try {
      const title = await generateSessionTitle(state, {
        complete: async (params) => {
          const result = await llmComplete({
            ...params,
            signal: abort.signal,
          });
          return { content: result.content, ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}) };
        },
        slotId: () => slotManager.sideCallSlotId(),
        // Which wire shape this call has to take. A cloud link answers a
        // bare prompt with an empty `content`, so the title has to be
        // asked for the way every other sub-call asks.
        toolTransport: resolveActiveLlmSlice().transport,
        onError: (err: unknown) =>
          logger.debug("session naming failed", {
            sessionId: state.id,
            error: err instanceof Error ? err.message : String(err),
          }),
      });
      if (title === null) return;
      // Teardown started while the completion was in flight: the store
      // below is closing, and a name is not worth a write into a runtime
      // that is going away. Keyed on teardown, not on `abort.signal`,
      // because the signal also carries the 20 s deadline — and that
      // deadline exists only to stop a hung call holding a side-call
      // slot, not to veto a title that did arrive. Nothing awaits
      // between here and the save, so the store cannot close under it.
      if (lifecycle.isShutdown()) return;
      const current = sessionStore.load(state.id) ?? state;
      // Lost the race, or someone named it in between: the first name
      // wins, because a label the operator has already navigated by must
      // not move.
      if (readSessionTitle(current.metadata) !== null) return;
      sessionStore.save({
        ...current,
        metadata: {
          ...current.metadata,
          [SESSION_TITLE_METADATA_KEY]: title,
        },
      });
    } catch (err) {
      // `executeTurn` fires this as a bare `void`, so a throw out of the
      // read-modify-write is an unhandled rejection — reported as a
      // crash. Losing the teardown race by a tick is the known one
      // (`TypeError: The database connection is not open`), but naming
      // is a nicety either way: log it and leave the session showing
      // its first prompt.
      logger.warn("session naming failed to store the title", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pendingSessionNamings.delete(abort);
    }
  };

  /**
   * Mark the session's row `running` for the turn about to run, so the
   * store says what is happening while it happens and a turn cut off by
   * a kill or a crash is recognised at the next boot
   * (`SessionStore.beginTurn`). Bookkeeping only: a mark that cannot be
   * written must not stop the turn.
   */
  const markTurnRunning = (sessionId: string): void => {
    try {
      sessionStore.beginTurn(sessionId);
    } catch (err) {
      logger.warn("could not mark the session running", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * End a turn that has no state to save — it threw — on the status it
   * actually ended with: `cancelled` when it had been told to stop (an
   * abort can surface as any error), `failed` with the error otherwise.
   * The transcript stays what it was before the turn (`session`); there
   * is nothing truer to put there. A cancel puts back the `lastError`
   * the session had before the turn, which a shutdown's stand-in may
   * have overwritten meanwhile.
   */
  const releaseThrownTurn = (
    session: SessionState,
    err: unknown,
    signal: AbortSignal | undefined,
  ): void => {
    try {
      sessionStore.releaseTurn(
        session.id,
        signal?.aborted === true
          ? { status: "cancelled", lastError: session.lastError }
          : {
              status: "failed",
              lastError: err instanceof Error ? err.message : String(err),
            },
      );
    } catch (releaseErr) {
      logger.warn("could not record how a turn ended", {
        sessionId: session.id,
        error:
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  };

  const executeTurn = async (
    session: SessionState,
    userMessage: string,
    runOptions: {
      maxSteps?: number;
      signal?: AbortSignal;
      providerId?: string;
      taskMaxDurationMs?: number;
      toolFilter?: (name: string) => boolean;
      toolRole?: ToolRole;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
    } = {},
  ): Promise<RunTurnResult> => {
    assertKnownProvider(runOptions.providerId);
    // A fusion worker session is throwaway: no recorder, no trace pin, no
    // memory, and — at the end — no save. The parent session's turn
    // owns the durable record of what the worker did.
    const worker = readFusionWorkerMeta(session.metadata);
    if (worker) {
      return turnContext.run({ sessionId: session.id }, async () => {
        try {
          // The worker's request is its brief: the operator's words sit
          // in its ORIGINAL REQUEST block, which is what the input guard
          // reads (`quotedRequestText`).
          turnRequests.set(session.id, userMessage);
          return await loop.runTurn(session, {
            userMessage,
            ephemeral: true,
            ...buildLoopTurnBudget(runOptions),
          });
        } finally {
          turnRequests.delete(session.id);
          // The prompt_captured hook still records the worker's window
          // occupancy under its id; nothing persists it, so drop it.
          traces.clearContextUsage(session.id);
          // A worker's turn is its whole life: nothing waits on its jobs.
          shellJobs.endSession(session.id);
        }
      });
    }
    ensureRecorder(session);
    // Pin this session for the duration of the turn. Without it a burst of
    // new sessions can push this one's recorder out mid-turn, after which
    // `emitAgentLoopEvent`'s `recorders.get(...)?.` silently drops every
    // remaining event of the turn and any tool call whose `pendingCalls`
    // entry went with it is logged with empty args.
    traces.pinSession(session.id);
    // Resolved before the turn runs, from the live config: the model the
    // operator chose for this turn is what the session should remember,
    // not whatever the config says by the time the turn finishes — and
    // deliberately not the fallback chain's emergency substitute either.
    const llmResolved = resolveLlmConfig(getConfig());
    const llmEntry = llmResolved.providers.find(
      (p) => p.id === llmResolved.activeTextProvider,
    );
    const llmStamp: SessionLlmStamp = {
      providerId: llmResolved.activeTextProvider,
      chatModel: llmEntry?.defaultChatModel ?? llmEntry?.model ?? null,
    };
    // What this turn is served by, against what the session's previous
    // turn was: a switch of provider, model, run mode or fusion worker —
    // or a fallover still in force — is told to the model once, as
    // `### route`, because the transcript it reads names the old model
    // and repeats the old model's refusals (session-route.ts).
    const turnRoute = resolveTurnRoute({
      resolved: llmResolved,
      runMode: resolveCurrentRunMode(),
      managedModelId: getConfig().localModels.managed.modelId ?? null,
      ...(runOptions.providerId !== undefined
        ? { pinnedProviderId: runOptions.providerId }
        : {}),
      // Not a stand-in the chain will pass over for the primary: the
      // turn starts on the primary then, and that is what it is told.
      fallbackOverrideId: fallbackChain.standingOverrideFor(session.id),
    });
    const previousRoute = readSessionRoute(session.metadata);
    const routeNote =
      previousRoute === null
        ? null
        : renderRouteChangeNote(previousRoute, turnRoute, {
            vision: resolveRouteVision(turnRoute.main.providerId),
          });
    if (routeNote !== null) {
      logger.info("serving route changed since the previous turn", {
        sessionId: session.id,
        from: previousRoute,
        to: turnRoute,
      });
    }
    return turnContext.run({ sessionId: session.id }, async () => {
      // Registered before the mark and ended after the turn's end is
      // written, so `shutdown` waiting on it waits for the row to be right.
      const inFlight = turnsInFlight.begin(runOptions.signal);
      markTurnRunning(session.id);
      try {
        // Recorded for `fusion.delegate`, which quotes it to the workers.
        const turnRequest = pickOriginalRequest({
          current: userMessage,
          earlierTurns: session.turns,
        });
        if (turnRequest !== undefined) {
          turnRequests.set(session.id, turnRequest);
        }
        // An explicit `maxSteps` from a caller (a durable task that pins
        // its own budget, `run --max-steps`) is a *ceiling* that caller
        // chose — honour it as one. Absent that, the config value is the
        // leg length and `agent.task.*` supplies the ceiling, so an
        // ordinary turn runs the task to completion instead of stopping
        // at the first checkpoint.
        const result = await loop.runTurn(session, {
          userMessage,
          // The same record the workers' briefs quote, pinned into the
          // orchestrator's own prompt once the packer drops its carrier.
          ...(turnRequest !== undefined
            ? { originalRequest: turnRequest }
            : {}),
          ...(routeNote !== null ? { routeNote } : {}),
          ...buildLoopTurnBudget(runOptions),
        });
        // Stamp the turn's window occupancy so the stored session can
        // restore the TUI's context gauge when it is reopened. A turn
        // that built no prompt (failed before step 1) leaves whatever
        // snapshot the previous turn persisted. The same save also
        // stamps what this turn ran on, so switching back into the
        // session later restores its provider/model (session-llm.ts).
        const usage = traces.readContextUsage(session.id);
        const finished: SessionState = {
          ...result.session,
          ...(usage === undefined ? {} : { contextUsage: usage }),
          metadata: {
            ...result.session.metadata,
            [SESSION_LLM_METADATA_KEY]: llmStamp,
            [SESSION_ROUTE_METADATA_KEY]: turnRoute,
          },
        };
        // The turn's end replaces its `running` mark (`beginTurn`).
        sessionStore.finishTurn(finished);
        // Name the thread once, from its first prompt, after the first
        // turn that actually answered. Fire-and-forget on purpose: the
        // turn is already saved and already returned, and an unnamed
        // session simply keeps showing its prompt — which is what every
        // session showed before. It must never delay or fail a reply.
        if (getConfig().agent.nameSessions && shouldNameSession(finished)) {
          void nameSession(finished);
        }
        // `finish` ended the whole session: its kept jobs go with it.
        if (finished.status === "completed") shellJobs.endSession(session.id);
        return { ...result, session: finished };
      } catch (err) {
        // The loop hands back a state for every ending it can classify —
        // reply, finish, max steps, failed, cancelled — so this is a turn
        // that threw, or whose save did. Its row must not go on saying
        // `running`.
        releaseThrownTurn(session, err, runOptions.signal);
        throw err;
      } finally {
        inFlight.end();
        // The turn is over, however it ended: the shell jobs it started
        // and did not `keep` are stopped here — the one choke point
        // every turn passes through (§"A turn is a task, not a step
        // budget").
        shellJobs.endTurn(session.id);
        traces.clearContextUsage(session.id);
        turnRequests.delete(session.id);
        traces.releaseSession(session.id);
      }
    });
  };

  /**
   * Public entry point for mid-turn steering. Deliberately does NOT
   * enqueue: the whole point is to reach the turn that is already
   * running, and going through `turnController` would put the message
   * behind it.
   *
   * One call, one decision. It deliberately does NOT pre-check
   * `turnController.isBusy`: that is a second fact which stops being
   * true at a different moment than "the loop will drain this again"
   * (the loop's final drain happens inside `runTurn`, `busy.delete`
   * later in the controller's `finally`). Guarding on it made this a
   * check-then-act with a real lost-update window — accepted here,
   * never delivered, and resurfacing at step 0 of some later turn under
   * a "while you were working" notice about a turn that had already
   * ended. `push` alone is authoritative: it accepts only while the
   * running turn's window is open, and that window is closed by the
   * same call that performs the final drain.
   */
  const steer = (sessionId: string, text: string): boolean =>
    steeringInbox.push(sessionId, text);

  const runTurn = async (
    session: SessionState,
    userMessage: string,
    runOptions: {
      maxSteps?: number;
      signal?: AbortSignal;
      eventHook?: TurnEventHook;
      origin?: TurnOrigin;
      providerId?: string;
      taskMaxDurationMs?: number;
      toolFilter?: (name: string) => boolean;
      toolRole?: ToolRole;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
    } = {},
  ): Promise<RunTurnResult> => {
    // Before the queue, so a bad pin rejects now rather than after
    // waiting behind whatever is running on the session.
    assertKnownProvider(runOptions.providerId);
    const origin = runOptions.origin ?? "cli";
    const submission = {
      sessionId: session.id,
      origin,
      // Re-read the freshest stored session when the queue hands over
      // the lock, not when the caller enqueued: between those moments a
      // turn from another origin (scheduler, HTTP, a TUI thread the
      // operator backgrounded) can finish and save, and running on the
      // caller's snapshot would make whichever turn saves last clobber
      // the other's transcript. This is the contract's own rule — never
      // hold a stale `SessionState` between enqueue and run; re-read
      // inside the queued callback (§"Concurrency contract"). A session
      // the store cannot answer for (never persisted, or deleted while
      // parked) falls back to the caller's copy, the pre-existing
      // behaviour.
      run: () =>
        executeTurn(
          sessionStore.load(session.id) ?? session,
          userMessage,
          runOptions,
        ),
      ...(runOptions.eventHook ? { eventHook: runOptions.eventHook } : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    } as const;

    // Product analytics: count only human-originated turns. Scheduler-
    // driven turns (durable tasks, cron, webhook ingress) are excluded
    // — they are not "a person sending a message". We measure the turn's
    // wall-clock duration (`latency_ms`) plus non-content shape metrics
    // (`step_count`, `outcome`), and emit whether the turn resolves or
    // throws — a failed/aborted turn is still a real "message sent"
    // attempt. On throw we have no result, so only `outcome: "failed"`
    // is known. `captureMessageSent` no-ops when analytics is disabled
    // and also fires the one-time `first_message_sent`.
    // A fusion worker turn is excluded for the same reason: it is the
    // orchestrator fanning out, not a person; the parent session's turn
    // is the one `message_sent` and the meter already count.
    if (origin === "scheduler" || origin === "fusion") {
      return turnController.enqueue(submission);
    }
    const startedAt = Date.now();
    turnUsageMeter.begin(session.id);
    try {
      const result = await turnController.enqueue(submission);
      captureMessageSent(observability.getAnalytics(), analyticsStateStore, {
        provider: providerRegistry.activeText.name,
        model: resolveActiveModelName(),
        latencyMs: Date.now() - startedAt,
        stepCount: result.stepCount,
        outcome: result.reason,
        ...turnUsageMeter.snapshot(session.id),
      });
      return result;
    } catch (error) {
      captureMessageSent(observability.getAnalytics(), analyticsStateStore, {
        provider: providerRegistry.activeText.name,
        model: resolveActiveModelName(),
        latencyMs: Date.now() - startedAt,
        outcome: "failed",
        ...turnUsageMeter.snapshot(session.id),
      });
      throw error;
    }
  };

  return { executeTurn, steer, runTurn };
}
