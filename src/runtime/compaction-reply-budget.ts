/** Tokens kept free for message framing and estimate error in a summary request. */
export const COMPACTION_REQUEST_MARGIN_TOKENS = 1024;

/**
 * The most of a window's input room the reasoning reserve may take. The
 * reserve is a convenience for thinking models; on a small window it must
 * shrink instead of leaving too little input room to compact at all.
 */
export const REASONING_RESERVE_MAX_SHARE = 0.25;

export interface CompactionReplyBudget {
  /** Reasoning allowance actually granted, after the small-window clamp. */
  reasoningReserve: number;
  /** The reply allowance sent as `maxTokens`: summary plus reasoning room. */
  maxTokens: number;
  /** What the instructions, anchors, previous summary and source may use. */
  inputBudget: number;
}

/**
 * Split a summary request's window into reply and input room. The
 * summary target (`summaryMaxTokens`) stays what the prompt asks for and
 * what the length check enforces; the reply allowance adds reasoning
 * room so a thinking model is not cut off before it writes the summary.
 *
 * `outputCap` is the provider entry's own `maxOutputTokens`, when set: a
 * model that cannot write more answers a larger allowance with a 400, so
 * the reserve shrinks to fit under it. It never goes below the summary
 * target; a cap smaller than that sends the target, as before the reserve.
 */
export function compactionReplyBudget(window: number, summaryMaxTokens: number, reasoningReserveTokens: number, outputCap?: number): CompactionReplyBudget {
  const room = window - summaryMaxTokens - COMPACTION_REQUEST_MARGIN_TOKENS;
  const cap = Number.isFinite(room) ? Math.max(0, Math.floor(room * REASONING_RESERVE_MAX_SHARE)) : reasoningReserveTokens;
  const underOutputCap = outputCap === undefined ? Infinity : outputCap - summaryMaxTokens;
  const reasoningReserve = Math.max(0, Math.min(reasoningReserveTokens, cap, underOutputCap));
  return {
    reasoningReserve,
    maxTokens: summaryMaxTokens + reasoningReserve,
    inputBudget: Math.floor(room - reasoningReserve),
  };
}
