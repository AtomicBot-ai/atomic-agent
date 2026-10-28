import type { StepContext, StepDependencies, LlmStreamParams } from "./step-contract.js";
import type { PreparedStepInference } from "./step-inference.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { DetectedModelFailure } from "../../llm/index.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { ToolCallBatchParseResult } from "./step-parsing.js";
import { detectModelFailure } from "../../llm/index.js";
import { estimateReasoningTokens } from "../../llm/reasoning-budget.js";
import { memoizeText, resolveReasoning } from "./step-reasoning.js";
import { isNativeToolsEmptyCompletionHandledByParser, parseDepsFor, renderOpenReasoningBlock, replyCapSent, stripTrailingReasoningPrefill } from "./step-parsing.js";
import { cutAgainReplyBatch, extractPartialAnswer, formatContinuationNotice, isContinuableTruncation, rewriteContinuedReply } from "./answer-continuation.js";

/** How one continuation ended; carried by the `answer_continued` event. */
export type AnswerContinuationOutcome = "completed" | "cut_again" | "abandoned";

export interface AnswerContinuationArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prepared: PreparedStepInference;
  /** The cut completion. */
  completion: CompletionResult;
  /** What `detectModelFailure` said about it. */
  failure: DetectedModelFailure;
  /** The transport that served the cut completion. */
  transport: ToolCallTransport;
  assumesOpenReasoning: (completion: CompletionResult) => boolean;
  /** The step's own batch parser, with the reply rewrite applied to its result. */
  parse: (
    completion: CompletionResult,
    rewrite: (batch: ToolCallBatch) => ToolCallBatch | null,
  ) => ToolCallBatchParseResult;
}

export interface ContinuedAnswer {
  /** The continuation's completion: what the step commits. */
  completion: CompletionResult;
  /** The batch with the joined answer as its reply. */
  batch: ToolCallBatch;
}

/**
 * Continue a reply the server cut at its length limit, once (see
 * `answer-continuation.ts`). `null` means the step goes on as before
 * this existed: the caller throws the original truncation error, and
 * the turn-level retry decides what happens next. A cancellation is
 * rethrown, never swallowed.
 */
export async function continueCutAnswer(
  args: AnswerContinuationArgs,
): Promise<ContinuedAnswer | null> {
  const { ctx, deps, prepared, completion, failure, transport } = args;
  if (!isContinuableTruncation(failure, completion)) return null;
  const partial = extractPartialAnswer(
    completion,
    transport,
    deps.profile,
    args.assumesOpenReasoning(completion),
  );
  if (partial === null) return null;
  const cause = failure.truncation!.cause;
  const report = (outcome: AnswerContinuationOutcome): void => {
    deps.onEvent?.({
      type: "answer_continued",
      stepIndex: ctx.stepIndex,
      cause,
      partialChars: partial.length,
      outcome,
    });
    deps.logger?.warn("cut reply continuation finished", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      cause,
      partialChars: partial.length,
      outcome,
    });
  };
  deps.logger?.warn("reply cut at the length limit; continuing it once", {
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    cause,
    partialChars: partial.length,
  });

  const startedAt = Date.now();
  let next: CompletionResult;
  try {
    next = await deps.llmComplete(
      buildContinuationRequest(prepared, deps, partial),
    );
  } catch (err) {
    if (ctx.signal.aborted || ctx.requestSignal?.aborted === true) throw err;
    report("abandoned");
    return null;
  }
  recordContinuation(args, next, Date.now() - startedAt);

  const nextFailure = detectModelFailure(next, {
    requestedMaxTokens: replyCapSent(next, prepared.replyCap),
    defaultReplyCap: prepared.replyCap,
    stage: "initial",
    contextWindow: deps.contextWindow ?? null,
  });
  if (nextFailure?.reason === "truncated") {
    // Cut again: stop here with what arrived. A looping rest is noise.
    const rest =
      nextFailure.truncation?.repetitive === true
        ? null
        : extractPartialAnswer(
            next,
            parseDepsFor(next, deps).toolTransport,
            deps.profile,
            args.assumesOpenReasoning(next),
          );
    report("cut_again");
    return { completion: next, batch: cutAgainReplyBatch(partial, rest) };
  }
  // Empty content beside a native tool call (the rest as a `reply`
  // call) is the parser's to read, as it is for any step.
  if (
    nextFailure !== null &&
    !isNativeToolsEmptyCompletionHandledByParser(parseDepsFor(next, deps), nextFailure.reason, next)
  ) {
    report("abandoned");
    return null;
  }
  const parsed = args.parse(next, (batch) =>
    rewriteContinuedReply(batch, partial),
  );
  if (!parsed.ok) {
    report("abandoned");
    return null;
  }
  report("completed");
  return { completion: next, batch: parsed.batch };
}

/**
 * The step's own request with the continuation notice at the end of
 * every prompt shape it carries — flat text, chat messages, the grammar
 * fallback variant and the template split — so whichever link serves
 * it sees the partial answer. Same prefill handling as the one-shot
 * repair: the notice goes before the reasoning open tag, never inside
 * an open think block. The cap is the step's own, untouched.
 */
export function buildContinuationRequest(
  prepared: Pick<
    PreparedStepInference,
    "llmParams" | "prompt" | "grammarPrompt" | "promptCarriesPrefill" | "thinkingOff"
  >,
  deps: Pick<StepDependencies, "profile" | "toolTransport">,
  partial: string,
): LlmStreamParams {
  const { llmParams, prompt, grammarPrompt, promptCarriesPrefill, thinkingOff } = prepared;
  const withNotice = (
    text: string,
    noticeTransport: ToolCallTransport,
    carriesPrefill: boolean,
  ): string => {
    const base = carriesPrefill
      ? stripTrailingReasoningPrefill(text, deps.profile, thinkingOff)
      : text;
    const open = carriesPrefill
      ? renderOpenReasoningBlock(deps.profile, thinkingOff)
      : "";
    const lines = [
      base.trimEnd(),
      "",
      formatContinuationNotice(partial, noticeTransport),
    ];
    if (open.length > 0) lines.push(open);
    return lines.join("\n");
  };
  const primary = deps.toolTransport ?? "grammar";
  return {
    ...llmParams,
    prompt: withNotice(prompt.text, primary, promptCarriesPrefill),
    ...(llmParams.messages
      ? {
          messages: {
            ...llmParams.messages,
            tail: withNotice(llmParams.messages.tail, "native_tools", false),
          },
        }
      : {}),
    ...(grammarPrompt
      ? {
          grammarPrompt: memoizeText(() =>
            withNotice(grammarPrompt(), "grammar", true),
          ),
        }
      : {}),
    ...(llmParams.chat
      ? {
          chat: {
            ...llmParams.chat,
            user: withNotice(llmParams.chat.user, "grammar", false),
          },
        }
      : {}),
  };
}

/** The bookkeeping every extra completion of a step gets (as the repair's does). */
function recordContinuation(
  args: AnswerContinuationArgs,
  next: CompletionResult,
  durationMs: number,
): void {
  const { ctx, deps, prepared } = args;
  const reasoning = resolveReasoning(
    next,
    deps.profile,
    args.assumesOpenReasoning(next),
  );
  deps.onCompletion?.(next);
  deps.onEvent?.({ type: "llm_completed", completion: next });
  deps.onEvent?.({
    type: "llm_raw_completion",
    stepIndex: ctx.stepIndex,
    attempt: 2,
    completion: next,
    reasoningTokens: estimateReasoningTokens(reasoning),
  });
  deps.metrics?.recordLlmCall({
    sessionId: ctx.session.id,
    promptTokens: next.timing?.promptTokens ?? prepared.prompt.tokens.total,
    completionTokens: next.timing?.predictedTokens ?? 0,
    durationMs,
    cacheReused: prepared.slot.cacheReused,
  });
  if (reasoning.length > 0) {
    deps.onEvent?.({ type: "reasoning", stepIndex: ctx.stepIndex, text: reasoning });
  }
}

