import type { StepContext, StepDependencies } from "./step-contract.js";
import type { PreparedStepInference } from "./step-inference.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import type { ParseDeps, ToolCallBatchParseResult } from "./step-parsing.js";
import { tryParseToolCalls, parseDepsFor, rawPreview, logTextPreview, replyFallbackBatch } from "./step-parsing.js";
import { validateBatch } from "./step-batch-policy.js";
import { GrammarError } from "../../llm/index.js";

export interface StepBatchParsingArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prepared: PreparedStepInference;
  completion: CompletionResult;
  policy: StepBatchPolicy;
  assumesOpenReasoning: (completion: CompletionResult) => boolean;
}

export function parseStepBatch(args: StepBatchParsingArgs): ToolCallBatchParseResult {
  const { deps, prepared, completion, policy } = args;
  const { stepDescriptors, thinkingOff } = prepared;

  let parsed = tryParseToolCalls(
    completion,
    deps.profile,
    parseDepsFor(completion, deps),
    // The list the REQUEST was built from — the strict-widened map must
    // come from the same array the wire payload did.
    stepDescriptors,
    thinkingOff,
  );
  if (parsed.ok) {
    const taken = policy.takeProgressNote(parsed.batch, completion);
    policy.setProgressNote(taken.note);
    parsed = { ok: true, batch: taken.batch };
    const validation = validateBatch(parsed.batch, deps.registry);
    if (!validation.ok) {
      // Try the cheap mechanical fixes first, in order:
      //   1. Wave split (issue #111): an oversized batch whose calls
      //      are ALL `pure_read` and schema-valid runs deterministically
      //      in bounded waves — no LLM repair round-trip.
      //   2. Approval-gated trim: a batch whose only failure is
      //      "approval-gated tools must be solo" (and is NOT oversized)
      //      trims to the first approval-gated call.
      // Anything else (terminal verbs in a batch, oversized mixed
      // batches, unknown resource class) still routes through the model
      // so it can re-plan.
      const split = policy.trySplitPureReadWaves(parsed.batch);
      if (split !== null) {
        parsed = split;
      } else {
        const trimmed = policy.tryTrimApprovalGated(parsed.batch, validation.error);
        if (trimmed !== null) {
          parsed = trimmed;
        } else {
          parsed = { ok: false, error: validation.error };
        }
      }
    }
  }
  return parsed;
}

export function finishStepBatchRepair(
  args: StepBatchParsingArgs,
  completion: CompletionResult,
  retryParseDeps: ParseDeps,
): { ok: true; batch: ToolCallBatch } {
  const { ctx, deps, prepared, policy, assumesOpenReasoning } = args;
  const { stepToolDescriptors, thinkingOff } = prepared;

  let parsed = tryParseToolCalls(
    completion,
    deps.profile,
    retryParseDeps,
    stepToolDescriptors,
    thinkingOff,
  );
  if (parsed.ok) {
    const taken = policy.takeProgressNote(parsed.batch, completion);
    policy.setProgressNote(taken.note);
    parsed = { ok: true, batch: taken.batch };
    const validation = validateBatch(parsed.batch, deps.registry);
    if (!validation.ok) {
      // Same mechanical-fix shortcuts for the post-repair attempt:
      // if the model came back from repair with another oversized
      // pure-read batch (wave split) or another approval-gated batch
      // (trim), fix it mechanically instead of escalating to
      // `GrammarError`. Surfaces in the same event/metric pair.
      const split = policy.trySplitPureReadWaves(parsed.batch);
      if (split !== null) {
        parsed = split;
      } else {
        const trimmed = policy.tryTrimApprovalGated(parsed.batch, validation.error);
        if (trimmed !== null) {
          parsed = trimmed;
        } else {
          parsed = { ok: false, error: validation.error };
        }
      }
    }
  }
  if (!parsed.ok) {
    deps.logger?.warn("tool-call parse failed after retry", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      rawLength: completion.content.length,
      rawPreview: logTextPreview(completion.content),
    });
    // Last resort: the model talked instead of emitting a call (small
    // models routinely answer "hi" in plain prose even under the
    // grammar). Wrap that prose as a `reply` so the turn closes with
    // the model's text — same degradation the `native_tools` path
    // already applies — instead of failing the whole loop. Only
    // reasoning came back? Then there is no answer to deliver and the
    // `GrammarError` still stands.
    const fallback = replyFallbackBatch(
      completion,
      deps.profile,
      assumesOpenReasoning(completion),
    );
    if (fallback === null) {
      throw new GrammarError(
        parsed.error.message,
        rawPreview(completion.content),
        { cause: parsed.error },
      );
    }
    deps.logger?.warn("degrading unparseable completion to a reply", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      reason: parsed.error.message,
    });
    parsed = { ok: true, batch: fallback };
  }
  return parsed;
}
