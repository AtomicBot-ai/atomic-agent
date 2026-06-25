import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { CancelledError } from "../llm/index.js";
import {
  isParallelWithinGroup,
  resourceClassFor,
  type ResourceClass,
} from "./tool-resource-class.js";
import {
  formatVetoInstruction,
  LOOP_VETO_DENIED_REASON,
  type LoopCheckVerdict,
  type ToolLoopTracker,
} from "./loop-detector.js";

/**
 * Loop-detection signal surfaced upward from a batch execution. The
 * agent loop consumes these after the step completes:
 *  - `warn`: a no-progress repeat was observed; inject a `### notice`.
 *  - `critical`: a call was vetoed (not executed); the synthetic result
 *    already carries the veto instruction.
 *  - `breaker`: the model ignored repeated vetoes — force a graceful
 *    reply to end the turn.
 */
export interface BatchLoopSignal {
  kind: "warn" | "critical" | "breaker";
  tool: string;
  count: number;
  detector: LoopCheckVerdict["detector"];
  warningKey: string;
}

/**
 * Static info about one call inside a batch. Carried verbatim back into
 * `BatchExecutionResult.results` so callers can correlate by index.
 */
export interface BatchCallInput {
  /** Position of this call in the model-emitted array. Stable, 0-based. */
  batchIndex: number;
  call: ToolCallPayload;
  /** Pre-computed class — saves re-classifying inside the planner. */
  resourceClass: ResourceClass;
}

export interface BatchExecutionContext {
  workingDir: string;
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
  /**
   * Fired immediately before the registry is invoked for each call.
   * Order: matches the order the executor reaches each call (within a
   * serialised group that is batch-index order; across concurrent
   * groups it is undefined). `batchIndex`/`batchSize` echo the inputs
   * so consumers can pair `started` ↔ `finished` events.
   */
  onCallStarted?: (info: { batchIndex: number; batchSize: number }) => void;
  /** Fired once a call's `CompressedToolResult` is in hand (success or error). */
  onCallFinished?: (info: {
    batchIndex: number;
    batchSize: number;
    result: CompressedToolResult;
    durationMs: number;
  }) => void;
  /**
   * Per-turn loop tracker. When present, every non-terminal call is run
   * through the synchronous loop gate (`check` → `recordCall`) before it
   * is dispatched, and its outcome is recorded after execution. Vetoed
   * calls never reach the registry. Absent ⇒ loop detection is disabled
   * for this step (legacy behaviour).
   */
  tracker?: ToolLoopTracker;
  /**
   * Names of skills already present in `SessionState.loadedSkills`. A
   * `skill.view` call targeting one of these is short-circuited with a
   * terse "already loaded" result instead of re-reading and re-dumping
   * the body (which bloats context and feeds the re-view loop). The tool
   * is never invoked for such calls. Absent ⇒ no short-circuit.
   */
  loadedSkillNames?: ReadonlySet<string>;
}

export interface BatchExecutionResult {
  /**
   * Always sorted by `batchIndex` ascending — matches the order the
   * model emitted calls. `compressed` is set for both successful and
   * failed invocations (failures are folded into a synthetic
   * `CompressedToolResult{status:"error"}` so the conversation
   * transcript stays in lockstep with the call array). `cancelled`
   * marks calls that never ran because the signal aborted mid-batch.
   */
  results: BatchCallResult[];
  /**
   * `true` if `signal.aborted` interrupted any group mid-flight. Even
   * when `true`, completed calls are still included in `results` so the
   * trace and transcript contain a faithful audit trail before the
   * caller throws `CancelledError`.
   */
  cancelled: boolean;
  /**
   * Loop-detection signals raised by the synchronous gate (warn /
   * critical / breaker), in observation order. Empty when no tracker was
   * supplied or no loop was detected.
   */
  loopSignals: BatchLoopSignal[];
}

export interface BatchCallResult {
  batchIndex: number;
  call: ToolCallPayload;
  resourceClass: ResourceClass;
  /** Final result for the call. Always set unless `cancelled` is true. */
  compressed?: CompressedToolResult;
  /** Wall-clock duration of the registry invocation (ms). 0 when cancelled. */
  durationMs: number;
  /** True when the call never started because the signal aborted first. */
  cancelled: boolean;
}

/**
 * Group a flat list of calls by `ResourceClass`. Group order in the
 * returned map matters for diagnostics only — the executor fires all
 * groups concurrently. Inside each group, calls remain in
 * batch-index order; the group entry preserves that order.
 */
export function planBatch(
  inputs: readonly BatchCallInput[],
): Map<ResourceClass, BatchCallInput[]> {
  const groups = new Map<ResourceClass, BatchCallInput[]>();
  for (const input of inputs) {
    const list = groups.get(input.resourceClass) ?? [];
    list.push(input);
    groups.set(input.resourceClass, list);
  }
  return groups;
}

/**
 * Run a batch of validated tool calls.
 *
 * Contract:
 *  - Calls in the `pure_read` group fan out via `Promise.allSettled`.
 *  - Every other batchable class serialises within its group, in
 *    batch-index order. This keeps observation order predictable for
 *    tools that mutate shared state (browser, sqlite, vision).
 *  - Distinct groups run **concurrently** with each other. Total wall
 *    time of the step ≈ `max(group_duration)`.
 *  - Failures of one call never abort siblings: the executor collects
 *    a `CompressedToolResult{status:"error"}` and continues.
 *  - Abort: if `signal.aborted` flips while a serialised group is
 *    iterating, the remaining calls in that group are marked
 *    `cancelled` and skipped. `pure_read` calls are launched all at
 *    once before the loop checks the signal again — those that already
 *    started run to completion (their tool implementations honour the
 *    signal cooperatively).
 *  - Terminal-tail barrier: when the batch contains a `terminal` call
 *    (the validator guarantees it is at the last position), every
 *    non-terminal call completes first; the terminal call then runs
 *    solo. A non-terminal failure does **not** suppress the terminal
 *    (the model's intent "do tools, then reply OK" is preserved even
 *    if one of the tools errored — the failure lands as a normal
 *    `status: "error"` slot and the turn still closes).
 */
export async function executeBatch(
  inputs: readonly BatchCallInput[],
  registry: ToolRegistry,
  ctx: BatchExecutionContext,
): Promise<BatchExecutionResult> {
  const batchSize = inputs.length;
  if (batchSize === 0) {
    return { results: [], cancelled: false, loopSignals: [] };
  }
  const slots: BatchCallResult[] = inputs.map((input) => ({
    batchIndex: input.batchIndex,
    call: input.call,
    resourceClass: input.resourceClass,
    durationMs: 0,
    cancelled: false,
  }));
  const loopSignals: BatchLoopSignal[] = [];

  // Split off any tail terminal call so the non-terminal portion runs
  // first as a normal grouped batch and the terminal runs strictly
  // after the barrier. Validator pins the terminal to `lastIdx`.
  const tailIsTerminal =
    inputs.length > 1 &&
    inputs[inputs.length - 1]!.resourceClass === "terminal";
  const nonTerminalInputs = tailIsTerminal ? inputs.slice(0, -1) : inputs;
  const terminalInput = tailIsTerminal ? inputs[inputs.length - 1]! : null;

  // Phase 1 (synchronous): run the loop gate for every non-terminal call
  // in batch-index order BEFORE any tool is dispatched. Because the gate
  // mutates the tracker synchronously, a duplicate call later in the same
  // parallel batch observes the `recordCall` of its earlier sibling, so
  // dup-within-batch loops are caught even though the invokes fan out.
  // Terminal verbs are NEVER gated (the model's intent to close the turn
  // must always survive). Vetoed calls fill their slot here and never
  // reach the registry.
  const toInvoke: BatchCallInput[] = [];
  for (const input of nonTerminalInputs) {
    if (ctx.signal.aborted) {
      slots[input.batchIndex] = { ...slots[input.batchIndex]!, cancelled: true };
      continue;
    }
    const gate = runSyncLoopGate(input, ctx, loopSignals);
    if (!gate.proceed && gate.vetoResult) {
      ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        compressed: gate.vetoResult,
        durationMs: 0,
      };
      ctx.onCallFinished?.({
        batchIndex: input.batchIndex,
        batchSize,
        result: gate.vetoResult,
        durationMs: 0,
      });
      continue;
    }
    // Short-circuit a `skill.view` for an already-loaded skill: return a
    // terse pointer instead of re-reading + re-dumping the body. The tool
    // is never invoked. The synthetic outcome is recorded so persistent
    // re-views still feed the no-progress streak (deterministic result ⇒
    // the existing loop veto eventually fires on spam).
    const alreadyLoaded = skillAlreadyLoadedResult(input, ctx);
    if (alreadyLoaded) {
      ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        compressed: alreadyLoaded,
        durationMs: 0,
      };
      if (ctx.tracker) {
        ctx.tracker.recordOutcome(
          input.call.tool,
          input.call.args,
          alreadyLoaded,
        );
      }
      ctx.onCallFinished?.({
        batchIndex: input.batchIndex,
        batchSize,
        result: alreadyLoaded,
        durationMs: 0,
      });
      continue;
    }
    toInvoke.push(input);
  }

  const groups = planBatch(toInvoke);

  const invokeOne = async (input: BatchCallInput): Promise<void> => {
    if (ctx.signal.aborted) {
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        cancelled: true,
      };
      return;
    }
    ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
    const startedAt = Date.now();
    let compressed: CompressedToolResult;
    try {
      compressed = await registry.invoke(input.call.tool, input.call.args, {
        workingDir: ctx.workingDir,
        sessionId: ctx.sessionId,
        stepIndex: ctx.stepIndex,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        // Cooperative cancellation: the tool honoured the signal and
        // threw. Bubble it as a CancelledError so the agent loop closes
        // the turn cleanly.
        throw err instanceof CancelledError
          ? err
          : new CancelledError(
              err instanceof Error ? err.message : "operation cancelled",
              { cause: err },
            );
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      compressed = compressToolResult({
        tool: input.call.tool,
        status: "error",
        output: cause.message,
        details: { errorName: cause.name },
      });
    }
    const durationMs = Date.now() - startedAt;
    slots[input.batchIndex] = {
      ...slots[input.batchIndex]!,
      compressed,
      durationMs,
    };
    // Record the real outcome so the next step's gate sees a completed
    // (args + result) entry. Terminal verbs are not tracked.
    if (ctx.tracker && input.resourceClass !== "terminal") {
      ctx.tracker.recordOutcome(input.call.tool, input.call.args, compressed);
    }
    ctx.onCallFinished?.({
      batchIndex: input.batchIndex,
      batchSize,
      result: compressed,
      durationMs,
    });
  };

  const groupTasks: Array<Promise<void>> = [];
  for (const [cls, calls] of groups) {
    if (isParallelWithinGroup(cls)) {
      // Pure-read fan-out. Launch every call immediately. Any that
      // already started keep running on cooperative signal — already
      // matches the legacy single-call path.
      groupTasks.push(
        (async (): Promise<void> => {
          await Promise.allSettled(calls.map(invokeOne));
        })(),
      );
      continue;
    }
    // Serialised group: process in batch-index order. Aborts skip the
    // tail and mark remaining calls as cancelled.
    groupTasks.push(
      (async (): Promise<void> => {
        for (const call of calls) {
          if (ctx.signal.aborted) {
            slots[call.batchIndex] = {
              ...slots[call.batchIndex]!,
              cancelled: true,
            };
            continue;
          }
          try {
            await invokeOne(call);
          } catch (err) {
            // CancelledError: stop the rest of this group and re-throw
            // upward so the agent loop's outer catch picks it up.
            if (err instanceof CancelledError) throw err;
            // Any other thrown value would already have been folded into
            // an error result inside `invokeOne`; defensive rethrow.
            throw err;
          }
        }
      })(),
    );
  }

  let cancelled = false;
  try {
    await Promise.all(groupTasks);
  } catch (err) {
    if (err instanceof CancelledError) {
      cancelled = true;
    } else {
      throw err;
    }
  }

  // Tail-terminal barrier: now that every non-terminal call has
  // settled (success, error, or cancelled), run the terminal call
  // solo. We deliberately attempt the terminal even when an earlier
  // call errored — the model batched it as "do tools, then reply",
  // and the reply text already encodes the model's intended close.
  // Only an aborted signal short-circuits the terminal.
  if (terminalInput !== null) {
    if (ctx.signal.aborted) {
      slots[terminalInput.batchIndex] = {
        ...slots[terminalInput.batchIndex]!,
        cancelled: true,
      };
    } else {
      try {
        await invokeOne(terminalInput);
      } catch (err) {
        if (err instanceof CancelledError) {
          cancelled = true;
        } else {
          throw err;
        }
      }
    }
  }

  // Final pass: any slot still without `compressed` and not flagged as
  // started belongs to a cancellation tail that we never reached.
  for (const slot of slots) {
    if (!slot.compressed && !slot.cancelled) {
      slot.cancelled = true;
    }
  }
  return {
    results: slots,
    cancelled: cancelled || ctx.signal.aborted,
    loopSignals,
  };
}

/**
 * If `input` is a `skill.view` whose target name is already present in
 * `ctx.loadedSkillNames`, return a terse synthetic result so the executor
 * can skip the real invocation. The result carries NO `skillLoaded`
 * detail, so `applyStateEffects` does not re-record or re-dump the body.
 * Returns `null` when the call is not an already-loaded `skill.view`.
 */
function skillAlreadyLoadedResult(
  input: BatchCallInput,
  ctx: BatchExecutionContext,
): CompressedToolResult | null {
  if (input.call.tool !== "skill.view" || !ctx.loadedSkillNames) return null;
  const rawName = (input.call.args as Record<string, unknown> | undefined)
    ?.name;
  if (typeof rawName !== "string" || rawName.length === 0) return null;
  if (!ctx.loadedSkillNames.has(rawName)) return null;
  return compressToolResult({
    tool: "skill.view",
    status: "ok",
    output: `skill "${rawName}" is already loaded — see ### loaded-skills; proceed without re-viewing.`,
    details: { skillAlreadyLoaded: rawName },
  });
}

/**
 * Synchronous loop gate. Runs `check` → `recordCall` against the tracker
 * BEFORE the call is dispatched. A `critical` verdict (or a tripped
 * breaker) produces a synthetic veto result that replaces the real
 * invocation; the veto outcome is recorded so it is excluded from the
 * no-progress streak (the streak then plateaus at `criticalThreshold`).
 * Terminal verbs and tracker-less steps always proceed unchanged.
 */
function runSyncLoopGate(
  input: BatchCallInput,
  ctx: BatchExecutionContext,
  loopSignals: BatchLoopSignal[],
): { proceed: boolean; vetoResult?: CompressedToolResult } {
  if (input.resourceClass === "terminal" || !ctx.tracker) {
    return { proceed: true };
  }
  const { tool, args } = input.call;
  const breakerTripped = ctx.tracker.isBreakerTripped(tool, args);
  // A wandering loop that crossed the escalation spread also ends the
  // turn gracefully (the redirect notice did not land). It rides the same
  // breaker path as the consecutive-veto streak.
  const wanderingEscalated = ctx.tracker.isWanderingEscalated(tool, args);
  const verdict = ctx.tracker.check(tool, args);
  ctx.tracker.recordCall(tool, args);

  if (verdict.level === "critical" || breakerTripped || wanderingEscalated) {
    const forceBreaker = breakerTripped || wanderingEscalated;
    const count = breakerTripped
      ? Math.max(verdict.count, ctx.tracker.breakerThreshold)
      : verdict.count;
    const vetoResult = compressToolResult({
      tool,
      status: "error",
      output: formatVetoInstruction({ tool, count }),
      details: {
        deniedReason: LOOP_VETO_DENIED_REASON,
        loopCount: count,
        detector: verdict.detector,
      },
    });
    ctx.tracker.recordOutcome(tool, args, vetoResult);
    loopSignals.push({
      kind: forceBreaker ? "breaker" : "critical",
      tool,
      count,
      detector: verdict.detector,
      warningKey: verdict.warningKey,
    });
    return { proceed: false, vetoResult };
  }

  if (verdict.level === "warn") {
    loopSignals.push({
      kind: "warn",
      tool,
      count: verdict.count,
      detector: verdict.detector,
      warningKey: verdict.warningKey,
    });
  }
  return { proceed: true };
}

/**
 * Helper: turn a parsed `ToolCallPayload[]` into the `BatchCallInput[]`
 * shape `executeBatch` expects, computing each call's resource class.
 * Index assignment matches the model's emit order.
 */
export function toBatchInputs(
  calls: readonly ToolCallPayload[],
): BatchCallInput[] {
  return calls.map((call, batchIndex) => ({
    batchIndex,
    call,
    resourceClass: resourceClassFor(call.tool),
  }));
}
