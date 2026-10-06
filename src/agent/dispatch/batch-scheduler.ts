import type { BatchLoopSignal, BatchCallInput, BatchExecutionContext, BatchExecutionResult, BatchCallResult } from "./batch-contract.js";
import { refuseBeforeDispatch, skillAlreadyLoadedResult, runFinalStepGate, runPlanModeGate, runFusionOrchestratorGate, runSyncLoopGate, observeReadCoverage } from "./batch-gates.js";



import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";

import { describeArgumentError } from "../../tools/argument-error-hint.js";


import { CancelledError } from "../../llm/index.js";
import {
  runWithApprovalLedger,
  type ToolApprovalRecord,
} from "../../approval/approval-ledger.js";
import {
  isParallelWithinGroup,
  resourceClassFor,
  type ResourceClass,
} from "../tool-resource-class.js";





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
 *    `cancelled` and skipped. `pure_read` calls launch per wave (or all
 *    at once when `maxWaveSize` is unset) before the loop checks the
 *    signal again — those that already started run to completion (their
 *    tool implementations honour the signal cooperatively).
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
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        cancelled: true,
      };
      continue;
    }
    // The final step first: nothing but a terminal runs on it, whatever
    // the other gates would say. A per-step tool set is the same
    // restriction with other names and rides the same gate.
    const final = runFinalStepGate(input, ctx);
    if (!final.proceed && final.vetoResult) {
      ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        compressed: final.vetoResult,
        durationMs: 0,
      };
      ctx.onCallFinished?.({
        batchIndex: input.batchIndex,
        batchSize,
        result: final.vetoResult,
        durationMs: 0,
      });
      continue;
    }
    // Plan mode next: a call that is not going to run should not spend
    // a slot in the loop tracker's history either. Recording it would
    // let a refused-and-retried tool trip the loop breaker, and end the
    // turn over an argument the model was never allowed to try.
    const plan = runPlanModeGate(input, registry, ctx);
    if (!plan.proceed && plan.vetoResult) {
      ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        compressed: plan.vetoResult,
        durationMs: 0,
      };
      ctx.onCallFinished?.({
        batchIndex: input.batchIndex,
        batchSize,
        result: plan.vetoResult,
        durationMs: 0,
      });
      continue;
    }
    // Then fusion's division of labour, for the same reason in the same
    // order: a mutation held back until the turn has delegated must not
    // spend a slot in the loop tracker either.
    const fusion = runFusionOrchestratorGate(input, registry, ctx);
    if (!fusion.proceed && fusion.vetoResult) {
      ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        compressed: fusion.vetoResult,
        durationMs: 0,
      };
      ctx.onCallFinished?.({
        batchIndex: input.batchIndex,
        batchSize,
        result: fusion.vetoResult,
        durationMs: 0,
      });
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

  /** The registry call itself; a thrown error becomes an error result. */
  const invokeRegistry = async (
    input: BatchCallInput,
  ): Promise<CompressedToolResult> => {
    try {
      return await registry.invoke(input.call.tool, input.call.args, {
        workingDir: ctx.workingDir,
        sessionId: ctx.sessionId,
        stepIndex: ctx.stepIndex,
        signal: ctx.signal,
        ...(ctx.toolRole !== undefined ? { toolRole: ctx.toolRole } : {}),
        ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
        ...(ctx.userGroundingTexts !== undefined
          ? { userGroundingTexts: ctx.userGroundingTexts }
          : {}),
        ...(ctx.providerId !== undefined ? { providerId: ctx.providerId } : {}),
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
      // An argument error names the key the tool wanted; the model also
      // needs the keys it actually sent (`patternes`, `"path"`) and the
      // closest accepted one, or it retries the same call blind. Keys
      // only — never values.
      const hint = describeArgumentError({
        tool: input.call.tool,
        args: input.call.args,
        message: cause.message,
      });
      return compressToolResult({
        tool: input.call.tool,
        status: "error",
        output: hint?.message ?? cause.message,
        details: {
          errorName: cause.name,
          ...(hint !== null
            ? {
                receivedKeys: hint.receivedKeys,
                expectedKeys: hint.expectedKeys,
              }
            : {}),
        },
      });
    }
  };

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
    // A call that is not what the model meant never reaches the
    // registry — see `refuseBeforeDispatch`. Terminals are exempt for
    // the reason every gate exempts them: a reply's text is shown, not
    // run, and the turn must be able to close.
    const refusal =
      input.resourceClass === "terminal"
        ? null
        : refuseBeforeDispatch(input.call);
    // Collects the approvals this call raises, whatever async context the
    // verdict arrives from (an HTTP resolve, a Telegram button). A denial
    // throws out of the tool and `invokeRegistry` turns it into an error
    // result, so the ledger is read after that too.
    const approvals: ToolApprovalRecord[] = [];
    compressed =
      refusal ??
      (await runWithApprovalLedger(approvals, () => invokeRegistry(input)));
    if (approvals.length > 0) {
      compressed = { ...compressed, approvals: [...approvals] };
    }
    const durationMs = Date.now() - startedAt;
    slots[input.batchIndex] = {
      ...slots[input.batchIndex]!,
      compressed,
      durationMs,
    };
    // A fan-out that came back is folded into the turn's ledger: how
    // many tasks a worker handed up is what decides whether the
    // orchestrator may run anything itself. The result is passed whole
    // rather than a flag, so the ledger reads the same per-task
    // statuses the model is about to read.
    if (input.call.tool === "fusion.delegate") ctx.onDelegated?.(compressed);
    // Record the real outcome so the next step's gate sees a completed
    // (args + result) entry. Terminal verbs are not tracked.
    if (ctx.tracker && input.resourceClass !== "terminal") {
      const outcome = ctx.tracker.recordOutcome(
        input.call.tool,
        input.call.args,
        compressed,
      );
      // Outcome-repeat detector (F25): the same result for the Nth time,
      // whatever the arguments were. Post-hoc and warn-only like the
      // read-coverage detector below — the call has already run, and a
      // legitimate poll or re-test looks exactly like this.
      if (outcome.repeat) {
        loopSignals.push({
          kind: "warn",
          tool: input.call.tool,
          count: outcome.count,
          detector: "outcome_repeat",
          warningKey: `outcome_repeat:${outcome.fingerprint}`,
        });
      }
      observeReadCoverage(input, compressed, ctx.tracker, loopSignals);
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
      // Pure-read fan-out, bounded to waves of `maxWaveSize` when set
      // (issue #111). Each wave is awaited before the next starts, so
      // waves execute in original order; the per-input `batchIndex`
      // keeps global result correlation intact. Absent ⇒ legacy
      // single-wave fan-out (the whole group at once).
      const waveSize = ctx.maxWaveSize ?? calls.length;
      groupTasks.push(
        (async (): Promise<void> => {
          for (let i = 0; i < calls.length; i += waveSize) {
            await Promise.allSettled(
              calls.slice(i, i + waveSize).map(invokeOne),
            );
          }
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