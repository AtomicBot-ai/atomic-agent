import type { BatchLoopSignal } from "../dispatch/batch-contract.js";
import type { SessionState } from "../../session/session-state.js";
import { recordTurn } from "../../session/session-state.js";
import { assistantReplyTurn } from "../../session/conversation-turn.js";
import { formatForcedLoopReply } from "./loop-notices.js";

/**
 * The loop breaker's wrap-up step (issue #828, ATO-2004).
 *
 * A breaker used to end the turn at once with the canned
 * `formatForcedLoopReply` text, so a research turn whose fetches had all
 * landed closed on "here is my best answer" with no answer in it. Now
 * the breaker hands the model one more step, run as the reserved final
 * step (`terminalOnly`, same catalog bytes), to summarize what the turn
 * already has in context. The canned text is the fallback whenever that
 * step cannot give an answer: no time or budget left for it, the step
 * fails, or the model still asks for a non-terminal tool.
 */
export interface LoopFinalStep {
  readonly tool: string;
  readonly count: number;
  readonly detector: BatchLoopSignal["detector"];
  readonly blockedCount?: number;
}

/**
 * The `### notice` line of the wrap-up step. It asks for the answer
 * itself: the desktop folds a reply that opens like the canned stop
 * into a warning bar, so no status preamble is asked for here.
 */
export const LOOP_FINAL_STEP_NOTICE =
  "The loop guard stopped further tool calls for this turn. Do not call any " +
  "non-terminal tool. Summarize what you found so far for the user with reply, " +
  "answering as much of the request as the gathered results allow and saying " +
  "plainly what is still missing. Start directly with the answer.";

export function loopFinalStepFrom(signal: BatchLoopSignal): LoopFinalStep {
  return {
    tool: signal.tool,
    count: signal.count,
    detector: signal.detector,
    ...(signal.blockedCount !== undefined ? { blockedCount: signal.blockedCount } : {}),
  };
}

/** The canned reply the breaker used to send; still the fallback. */
export function forcedLoopReplyText(pending: LoopFinalStep): string {
  return formatForcedLoopReply(
    pending.tool,
    pending.count,
    pending.detector,
    pending.blockedCount,
  );
}

/**
 * Close the turn with the canned reply: record it as the turn's
 * assistant reply and announce it the way the old breaker path did.
 */
export function recordForcedLoopReply(
  state: SessionState,
  pending: LoopFinalStep,
  emitReply: (text: string) => void,
): SessionState {
  const text = forcedLoopReplyText(pending);
  const next = recordTurn(state, assistantReplyTurn(text));
  emitReply(text);
  return next;
}
