import { ContextWindowTooSmallError } from "../../llm/reliability/context-window-too-small.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";
import {
  CONVERSATION_CAP_FLOOR,
  CONVERSATION_CAP_SAFETY_MARGIN,
  MIN_SMALL_WINDOW_REPLY_RESERVE,
} from "../../prompt/token-budget.js";

/**
 * Refuse to send a local step whose fixed part leaves no room for a
 * reply (ATO-1678).
 *
 * The fixed part is everything in the prompt but the transcript: the
 * instructions, the memory and world sections and, on a `native_tools`
 * link, the `tools` array. The budget already shares what it leaves
 * between the transcript and the reply (`crowdedReplyReserve`). When it
 * leaves less than the transcript floor plus the smallest reply reserve
 * a small window keeps, plus the safety margin, no packing helps: the
 * request would come back cut after a few tokens on every try. The step
 * fails before the request with `ContextWindowTooSmallError`, which
 * names the two fixes and is not reported to error reporting.
 *
 * Only a known window, and only a local prompt: a cloud prompt has its
 * own budget (`build-cloud-prompt.ts`) and windows far past this check.
 */
export function assertPromptFitsWindow(
  prompt: Pick<BuiltPrompt, "contextWindow" | "tokens">,
  modelMode: "local" | "cloud" | undefined,
): void {
  if (modelMode === "cloud") return;
  const window = prompt.contextWindow;
  if (window === null || !Number.isFinite(window) || window <= 0) return;
  const fixedTokens = promptFixedTokens(prompt.tokens);
  const needed =
    fixedTokens +
    CONVERSATION_CAP_FLOOR +
    MIN_SMALL_WINDOW_REPLY_RESERVE +
    CONVERSATION_CAP_SAFETY_MARGIN;
  if (needed <= window) return;
  throw new ContextWindowTooSmallError(
    window,
    fixedTokens,
    prompt.tokens.toolSchema ?? 0,
  );
}

/** Tokens of everything in the prompt but the transcript and its summary. */
export function promptFixedTokens(tokens: BuiltPrompt["tokens"]): number {
  return Math.max(
    0,
    tokens.total - tokens.conversation - (tokens.compaction ?? 0),
  );
}
