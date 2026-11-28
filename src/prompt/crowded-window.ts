/**
 * The reply reserve on a window the fixed part of the prompt crowds
 * (ATO-1678).
 *
 * `effectiveReplyReserve` sizes the reserve from the window alone: half
 * of a 32k window is 16384. On a `native_tools` link with many tools
 * and MCP servers the fixed part (stable prefix plus the `tools` array,
 * 16k tokens of schemas on the Sentry events) already takes 20k of that
 * window, so the full reserve no longer fits beside it. The transcript
 * cap then went negative, clamped to the 512-token floor, and the reply
 * still got only what the prompt happened to leave: a few hundred
 * tokens, so the turn failed as `context_full`.
 *
 * When the full reserve would leave the transcript under its floor, the
 * reserve shares what the fixed part leaves (`leftover`) with the
 * transcript instead: {@link CROWDED_WINDOW_REPLY_SHARE} of it, never
 * less than the caller's minimum and never more than the full reserve.
 * The same even split `REPLY_RESERVE_MAX_WINDOW_SHARE` makes of a whole
 * window that cannot hold the configured cap.
 *
 * A window that holds the fixed part and the full reserve keeps the
 * figure `effectiveReplyReserve` gives, unchanged. Pure numbers, no
 * imports, so `token-budget.ts` can use it without an import cycle.
 */

/** Share of the leftover a crowded window's reply reserve takes. */
export const CROWDED_WINDOW_REPLY_SHARE = 0.5;

export interface CrowdedReplyReserveInput {
  /** The reserve `effectiveReplyReserve` gives on this window. */
  fullReserve: number;
  /**
   * Window room left after every fixed section and the safety margin:
   * what the transcript and the reply share.
   */
  leftover: number;
  /** Smallest transcript cap (`CONVERSATION_CAP_FLOOR`). */
  transcriptFloor: number;
  /** Smallest reserve a crowded window keeps (`MIN_SMALL_WINDOW_REPLY_RESERVE`). */
  minReserve: number;
}

/**
 * The reply reserve the budget holds back on this window: the full
 * reserve when the transcript still gets its floor beside it, else the
 * shared one described above. A non-positive full reserve (`0`, "no
 * client-side cap") stays as it is.
 */
export function crowdedReplyReserve(input: CrowdedReplyReserveInput): number {
  const { fullReserve, leftover, transcriptFloor, minReserve } = input;
  if (!Number.isFinite(fullReserve) || fullReserve <= 0) return fullReserve;
  if (leftover - fullReserve >= transcriptFloor) return fullReserve;
  const shared = Math.max(
    minReserve,
    Math.floor(Math.max(0, leftover) * CROWDED_WINDOW_REPLY_SHARE),
  );
  return Math.min(fullReserve, shared);
}
