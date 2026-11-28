import {
  packConversation,
  type ConversationTurn,
  type PackConversationOptions,
  type PackedConversation,
} from "../session/conversation-turn.js";
import { renderPackedConversation } from "./build-prompt-world-conversation.js";
import { estimateTokens } from "./token-budget.js";

/**
 * Pack the transcript so it really fits its cap on a known window
 * (ATO-1678).
 *
 * `packConversation` never drops the current request: the last user
 * turn and the opening turn of the current task stay pinned, with every
 * call and result after them. It bounds each pinned tool result to a
 * share of the budget, but a long task of many calls still renders far
 * past the cap. On the Sentry events the cap was 512 tokens and the
 * pinned task went out at 10.5k, so the request reached the end of the
 * window and the reply got a few hundred tokens.
 *
 * When the first pack overflows `maxTokens`, this packs again under a
 * halved cap, up to {@link MAX_REFIT_ROUNDS} times. A smaller cap
 * bounds every pinned tool result harder (the bound is a share of the
 * cap) while the pins keep the same start, so the request and its calls
 * stay in view and only result bodies shrink. It stops at the first
 * pack that fits and otherwise returns the smallest one. A transcript
 * that fits the first time is returned untouched, so nothing changes
 * below the cap.
 *
 * Only for a known window: with none the cap is a configured figure,
 * not a wall, and the pins may run past it as before.
 */
export const MAX_REFIT_ROUNDS = 4;

export function packConversationToFit(
  turns: readonly ConversationTurn[],
  maxTokens: number,
  options: PackConversationOptions,
  windowKnown: boolean,
): PackedConversation {
  const first = packConversation(turns, maxTokens, options);
  if (!windowKnown || maxTokens <= 0) return first;
  let best = first;
  let bestTokens = renderedTokens(first);
  let cap = maxTokens;
  for (
    let round = 0;
    round < MAX_REFIT_ROUNDS && bestTokens > maxTokens;
    round += 1
  ) {
    cap = Math.floor(cap / 2);
    if (cap < 1) break;
    const packed = packConversation(turns, cap, options);
    const tokens = renderedTokens(packed);
    if (tokens < bestTokens) {
      best = packed;
      bestTokens = tokens;
    }
  }
  return best;
}

function renderedTokens(packed: PackedConversation): number {
  return estimateTokens(renderPackedConversation(packed));
}
