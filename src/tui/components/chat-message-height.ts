import type { ChatMessage, ToolCardEntry, TuiState } from "../tui-state.js";

/**
 * Estimated number of terminal rows occupied by a finalised chat
 * message after rendering. Pure function — used by `ChatLog` to pick
 * how many of the newest messages fit in the current viewport without
 * letting Yoga shrink padding/margin to make them all "fit". The
 * estimate intentionally errs on the **high** side: under-estimating
 * heights would let Ink render messages that overflow and trigger the
 * exact "everything squashed" failure mode we are avoiding.
 *
 * Heights line up with the bubble layout in `user-bubble.tsx`,
 * `assistant-bubble.tsx`, and `reasoning-bubble.tsx`:
 *   - 1 row `marginTop` between bubbles
 *   - 1 row `paddingTop` inside the bubble
 *   - N rows of body (counted from raw `\n`-separated lines + a
 *     conservative 1-row pad; precise wrap-aware counting would need
 *     access to the live content width and is overkill for the
 *     "should this message render at all" decision)
 *   - 1 row `paddingBottom` inside the bubble
 *
 * Tool cards / reasoning bubbles add their own envelope on top.
 */
const BUBBLE_OVERHEAD_ROWS = 3; // marginTop + paddingTop + paddingBottom
const REASONING_BUBBLE_OVERHEAD_ROWS = 5; // marginTop + paddingTop + 1-line header + paddingBottom + safety
const TOOL_CARD_BASE_ROWS = 2;
const ASSISTANT_FOOTER_ROWS = 1;

function bodyLines(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
}

export function estimateMessageHeight(message: ChatMessage): number {
  const bodyRows = bodyLines(message.text);
  let total = bodyRows + BUBBLE_OVERHEAD_ROWS;
  if (message.role === "assistant") {
    if (message.reasoningBlocks && message.reasoningBlocks.length > 0) {
      total += REASONING_BUBBLE_OVERHEAD_ROWS + 1;
    }
    const visibleToolCards =
      message.toolCards?.filter((c) => c.tool !== "reply") ?? [];
    total += visibleToolCards.reduce(
      (acc, card) => acc + estimateToolCardHeight(card),
      0,
    );
    if ((message.toolSteps ?? 0) > 0) {
      total += ASSISTANT_FOOTER_ROWS;
    }
  }
  return total;
}

export function estimateToolCardHeight(card: ToolCardEntry): number {
  const summaryLines = bodyLines(card.summary);
  return TOOL_CARD_BASE_ROWS + Math.max(0, summaryLines - 1);
}

/**
 * Estimated rows of the live streaming tail (reasoning + in-flight
 * tools + streaming reply). Mirrors the structure of `StreamingTail`
 * **including** its collapse/expand logic: while no reply text has
 * arrived the reasoning bubble renders expanded (full body), but the
 * moment streaming reply text starts the bubble collapses to a one
 * line summary. The estimator must follow the exact same branching —
 * otherwise `maxOffset` over-counts by hundreds of fantom rows on a
 * long chain-of-thought, and the operator scrolls past the first
 * message into blank space.
 */
export function estimateStreamingTailHeight(state: TuiState): number {
  let total = 0;
  if (state.reasoning.length > 0) {
    const expanded =
      state.streamingAssistantText === null ||
      state.streamingAssistantText.length === 0;
    if (expanded) {
      const text = state.reasoning.map((r) => r.text).join("\n\n");
      total += REASONING_BUBBLE_OVERHEAD_ROWS + bodyLines(text);
    } else {
      total += REASONING_BUBBLE_OVERHEAD_ROWS + 1;
    }
  }
  const visibleCards = state.streamingToolCards.filter(
    (c) => c.tool !== "reply",
  );
  total += visibleCards.reduce(
    (acc, card) => acc + estimateToolCardHeight(card),
    0,
  );
  const visibleCalls = state.streamingToolCalls.filter(
    (c) => c.tool !== "reply",
  );
  total += visibleCalls.length * TOOL_CARD_BASE_ROWS;
  if (state.streamingAssistantText !== null) {
    total += BUBBLE_OVERHEAD_ROWS + bodyLines(state.streamingAssistantText);
  }
  return total;
}

/**
 * Picks the newest N messages that fit into `availableRows` after
 * `dropFromEnd` newest ones are skipped (the scroll offset). Walks
 * from the bottom and stops once the next message would overflow the
 * remaining budget — the topmost visible message is therefore always
 * fully rendered (no partial top-clip; Yoga is too aggressive at
 * shrinking when a child overflows the cross axis).
 *
 * Returns the slice (in original order) and how many older messages
 * were hidden above it — surfaced as `hiddenAbove` so the caller can
 * render an "↑ N earlier messages" hint.
 */
export interface VisibleSlice {
  visible: ChatMessage[];
  hiddenAbove: number;
  hiddenBelow: number;
}

export function selectVisibleMessages(
  messages: readonly ChatMessage[],
  dropFromEnd: number,
  availableRows: number,
): VisibleSlice {
  const candidates = messages.slice(0, messages.length - dropFromEnd);
  if (candidates.length === 0) {
    return { visible: [], hiddenAbove: 0, hiddenBelow: dropFromEnd };
  }
  if (availableRows <= 0) {
    // Always show at least the newest one in the candidate window so
    // the chat surface is never blank when the operator scrolls.
    return {
      visible: [candidates[candidates.length - 1]!],
      hiddenAbove: candidates.length - 1,
      hiddenBelow: dropFromEnd,
    };
  }
  const picked: ChatMessage[] = [];
  let acc = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const m = candidates[i]!;
    const h = estimateMessageHeight(m);
    if (acc + h > availableRows && picked.length > 0) break;
    picked.unshift(m);
    acc += h;
  }
  const hiddenAbove = candidates.length - picked.length;
  return { visible: picked, hiddenAbove, hiddenBelow: dropFromEnd };
}
