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
    return { results: [], cancelled: false };
  }
  const slots: BatchCallResult[] = inputs.map((input) => ({
    batchIndex: input.batchIndex,
    call: input.call,
    resourceClass: input.resourceClass,
    durationMs: 0,
    cancelled: false,
  }));

  // Split off any tail terminal call so the non-terminal portion runs
  // first as a normal grouped batch and the terminal runs strictly
  // after the barrier. Validator pins the terminal to `lastIdx`.
  const tailIsTerminal =
    inputs.length > 1 &&
    inputs[inputs.length - 1]!.resourceClass === "terminal";
  const nonTerminalInputs = tailIsTerminal ? inputs.slice(0, -1) : inputs;
  const terminalInput = tailIsTerminal ? inputs[inputs.length - 1]! : null;
  const groups = planBatch(nonTerminalInputs);

  const runOne = async (input: BatchCallInput): Promise<void> => {
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
          await Promise.allSettled(calls.map(runOne));
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
            await runOne(call);
          } catch (err) {
            // CancelledError: stop the rest of this group and re-throw
            // upward so the agent loop's outer catch picks it up.
            if (err instanceof CancelledError) throw err;
            // Any other thrown value would already have been folded into
            // an error result inside `runOne`; defensive rethrow.
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
        await runOne(terminalInput);
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
  return { results: slots, cancelled: cancelled || ctx.signal.aborted };
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
