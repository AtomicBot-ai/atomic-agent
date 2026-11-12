import { Box, Text, measureElement, type DOMElement } from "ink";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { computeChatViewportRows } from "../layout.js";
import { selectExtraChromeRows } from "../select-chrome-rows.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { theme } from "../theme/theme.js";
import { AssistantBubble } from "./assistant-bubble.js";
import { selectComposerBackend } from "../composer-switch/composer-backend-selectors.js";
import { isVisibleToolCard } from "./chat-finalised-message.js";
import type { CodingMode } from "../coding-mode/coding-mode.js";
import {
  estimateMessageHeight,
  estimatePendingSteerHeight,
  estimateStreamingTailHeight,
} from "./chat-message-height.js";
import { chatOverscanRows, computeChatWindow } from "./chat-window.js";
import { useMeasuredRowHeights } from "./use-measured-row-heights.js";
import { WindowedMessages } from "./windowed-messages.js";
import { ReasoningBubble } from "./reasoning-bubble.js";
import { SplashBanner } from "./splash-banner.js";
import { ThinkingIndicator } from "./thinking-indicator.js";
import { ToolCard } from "./tool-card.js";
import { UserBubble } from "./user-bubble.js";
import { turnFoldsOf } from "../render/turn-collapse.js";

/**
 * Height-cache key for the rows that are always drawn under the
 * finalised messages. NUL keeps it apart from any message id.
 */
const LIVE_ROWS_ID = "\u0000live-rows";

interface ChatLogProps {
  state: TuiState;
  /**
   * Runs the drafted plan under `mode`, and puts it away. Both optional
   * so the many tests that render a log need not supply them; without
   * them the plan simply carries no buttons.
   */
  onPlanExecute?: (mode: CodingMode) => void;
  onPlanDismiss?: () => void;
  /**
   * Optional dispatcher used to self-correct an over-scrolled state.
   * Whenever `state.chatScrollOffset` exceeds the visually allowed
   * `maxOffset` (e.g. after a session swap shrinks the chat, or the
   * model expands a chain-of-thought mid-turn), `ChatLog` fires a
   * negative `chat_scrolled` to bring the state back in line. Tests
   * may omit this — the visual clamp on its own is enough.
   */
  dispatch?: (action: TuiAction) => void;
}

/**
 * Single scrolling chat surface — line-by-line scroll, web-page-like.
 *
 * The trick: render the whole chat (every finalised message + the
 * streaming tail + the thinking indicator) as a single flex column
 * pinned to the bottom of a fixed-height viewport with `overflow:
 * hidden`. When the column is taller than the viewport, Yoga clips
 * the **top** rows automatically; the bottom-most line is always at
 * the prompt edge, exactly like a web chat surface.
 *
 * Smooth scroll: the column is drawn `state.chatScrollOffset` rows
 * lower than Yoga placed it (`contentOffsetY={-offset}`, Ink 8). Its
 * bottom edge then sits below the viewport, older rows move in at the
 * top, and `overflow: hidden` clips the rest. One wheel notch = one
 * row. Yoga's layout does not move, which is why `absoluteRect` in the
 * mouse registry adds the offset back for hit-testing.
 *
 * Only the messages near the viewport are drawn (ATO-650): the window
 * is `computeChatWindow` over each message's height, measured once it
 * has been drawn and estimated before that, plus a screen of overscan
 * each side. The messages outside it are blank spacers of the same
 * height, so the column, the scroll clamp and every drawn row's cell
 * are what they would be with the whole history rendered.
 *
 * `state.chatScrollOffset` carries **lines** (not messages) since
 * the last refactor. The unit changed but the field name stayed for
 * cross-cutting compat with reducers / tests / sidecar.
 *
 * Empty surface → centred splash banner; everything else falls
 * through into the bottom-anchored column.
 */
export function ChatLog({
  state,
  dispatch,
  onPlanExecute,
  onPlanDismiss,
}: ChatLogProps): ReactElement {
  const terminalSize = useTerminalSize();
  const finalised = state.messages;
  const hasStreamingTail =
    state.streamingAssistantText !== null ||
    state.streamingToolCalls.length > 0 ||
    state.streamingToolCards.length > 0 ||
    state.reasoning.length > 0;
  const showIndicator = state.status === "running" || Boolean(state.contextCompactions[state.session.sessionId ?? ""]);
  // Messages sent into the running turn that the loop has not read yet.
  // They go where anything new goes — after everything the turn has
  // said so far, and ahead of the spinner, which stays pinned to the
  // bottom as the live thing it is. This is a chat: a message you send
  // lands at the end of the conversation, and the "still working"
  // indicator sits below it. When the loop folds one in, `steer_applied`
  // moves it into the transcript proper with the step it reached, and
  // it does not move on screen doing so.
  const pendingSteers = state.pendingSteers;
  // Finished turns fold into one line (ATO-963) unless the operator keeps
  // their steps open. The turn still running is never folded.
  const folds = turnFoldsOf(finalised, {
    always: state.showSteps,
    running: state.status === "running",
  });
  const foldStateOf = (id: string): "none" | "closed" | "open" =>
    folds.has(id)
      ? state.turnsExpandedById[id] === true
        ? "open"
        : "closed"
      : "none";
  const isEmpty =
    finalised.length === 0 &&
    !hasStreamingTail &&
    !showIndicator &&
    pendingSteers.length === 0;
  // All hooks must run unconditionally — only the JSX branches on
  // `isEmpty`. Compute viewport / measured-K / clamp regardless,
  // even when the early return for the splash branch fires below.
  // Rows the composer's adaptive chrome is spending over its one-row
  // baseline — the wrapped hint strip, today. They come out of the
  // transcript: `CHROME_ROWS` counts one row for the strip, and a
  // viewport that ignored the surplus would keep its bottom lines hidden
  // behind the composer.
  const extraChromeRows = selectExtraChromeRows(state, terminalSize);
  const viewport = computeChatViewportRows(
    terminalSize.rows,
    terminalSize.columns,
    extraChromeRows,
  );
  // Rows of each finalised message: measured where it has been drawn at
  // this width, estimated otherwise. The live rows under them (tail,
  // pending steers, spinner) are measured the same way as one block.
  const rowIds = useMemo(
    () => [...finalised.map((m) => m.id), LIVE_ROWS_ID],
    [finalised],
  );
  const measured = useMeasuredRowHeights(
    terminalSize.columns,
    rowIds,
    LIVE_ROWS_ID,
  );
  const heights = finalised.map((m) =>
    measured.heightOf(m.id, () =>
      estimateMessageHeight(m, foldStateOf(m.id)),
    ),
  );
  const bottomRows = measured.heightOf(
    LIVE_ROWS_ID,
    () =>
      (hasStreamingTail ? estimateStreamingTailHeight(state) : 0) +
      (showIndicator ? 2 : 0) +
      pendingSteers.reduce(
        (acc, text) => acc + estimatePendingSteerHeight(text),
        0,
      ),
  );
  // First-frame fallback for `K` until the post-mount `measureElement`
  // call returns the truth; after that, `measuredContentRows` is the
  // source of truth.
  const estimatedContentRows = isEmpty
    ? 0
    : heights.reduce((acc, h) => acc + h, 0) + bottomRows;
  const innerRef = useRef<DOMElement>(null);
  const [measuredContentRows, setMeasuredContentRows] = useState<number>(0);
  // Re-measure the inner column on every render so the clamp tracks
  // actual rendered geometry — including text wrap, mid-turn CoT
  // expansion, and session swaps. `measureElement` returns Yoga's
  // computed layout regardless of whether it is currently clipped by
  // an `overflow: hidden` ancestor.
  useEffect(() => {
    if (!innerRef.current) return;
    const layout = measureElement(innerRef.current);
    const h = Math.max(0, layout.height ?? 0);
    if (h > 0 && h !== measuredContentRows) setMeasuredContentRows(h);
  });
  const totalContentRows =
    measuredContentRows > 0 ? measuredContentRows : estimatedContentRows;
  // Cap the scroll so the very first message lands at the top and a
  // further wheel-up tick does nothing. Floor stop matches opencode.
  const maxOffset = Math.max(0, totalContentRows - viewport);
  const offset = Math.max(0, Math.min(state.chatScrollOffset, maxOffset));
  // Self-correct an over-scrolled state — happens after a session
  // swap that shrank the chat, or when `measuredContentRows` lands
  // smaller than the previous estimate. A single dispatch per frame
  // is fine: the reducer is idempotent on a no-op delta.
  useEffect(() => {
    if (!dispatch) return;
    if (state.chatScrollOffset > maxOffset) {
      const delta = maxOffset - state.chatScrollOffset; // negative
      dispatch({ type: "chat_scrolled", delta });
    }
  }, [dispatch, state.chatScrollOffset, maxOffset]);
  if (isEmpty) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center">
        <SplashBanner extraChromeRows={extraChromeRows} />
      </Box>
    );
  }
  const stickyBottom = offset === 0;
  // The Fusion tint on the bubbles — the same answer the composer's
  // backend control gives, so the two halves of the chat zone agree.
  const fusion = selectComposerBackend(state) === "fusion";
  const rowWindow = computeChatWindow({
    heights,
    bottomRows,
    offset,
    viewportRows: viewport,
    overscanRows: chatOverscanRows(viewport),
  });
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      justifyContent="flex-end"
      overflow="hidden"
      height={viewport}
    >
      <Box flexDirection="column" flexShrink={0} contentOffsetY={-offset}>
        <Box ref={innerRef} flexDirection="column" flexShrink={0}>
          {rowWindow.spacerAbove > 0 ? (
            <Box height={rowWindow.spacerAbove} flexShrink={0} />
          ) : null}
          <WindowedMessages
            messages={finalised}
            start={rowWindow.start}
            end={rowWindow.end}
            refFor={measured.refFor}
            state={state}
            fusion={fusion}
            folds={folds}
            onPlanExecute={onPlanExecute}
            onPlanDismiss={onPlanDismiss}
          />
          {rowWindow.spacerBelow > 0 ? (
            <Box height={rowWindow.spacerBelow} flexShrink={0} />
          ) : null}
          <Box
            ref={measured.refFor(LIVE_ROWS_ID)}
            flexDirection="column"
            flexShrink={0}
          >
            {hasStreamingTail ? (
              <StreamingTail state={state} fusion={fusion} />
            ) : null}
            {pendingSteers.map((text, idx) => (
              <UserBubble
                // Position is the only identity a pending steer has; it
                // is removed by value the moment it resolves, and two
                // identical steers must still render as two bubbles.
                key={`pending-steer-${idx}`}
                text={text}
                fusion={fusion}
                pending
              />
            ))}
            {showIndicator ? <ThinkingIndicator state={state} /> : null}
          </Box>
        </Box>
      </Box>
      {!stickyBottom ? <ScrollHint offset={offset} /> : null}
    </Box>
  );
}

function StreamingTail({
  state,
  fusion,
}: {
  state: TuiState;
  fusion: boolean;
}): ReactElement | null {
  const hasStreaming =
    state.streamingAssistantText !== null ||
    state.streamingToolCalls.length > 0 ||
    state.streamingToolCards.length > 0 ||
    state.reasoning.length > 0;
  if (!hasStreaming) return null;
  const reasoningTexts = state.reasoning.map((r) => r.text);
  // Keep CoT fully visible while the model is still "thinking" (no
  // reply text yet), then collapse to a one-line summary the moment
  // the final assistant reply starts streaming — the user's eye
  // should follow the answer, not the stale reasoning trail.
  const reasoningExpanded =
    state.streamingAssistantText === null ||
    state.streamingAssistantText.length === 0;
  return (
    <Box flexDirection="column">
      {reasoningTexts.length > 0 ? (
        <ReasoningBubble blocks={reasoningTexts} expanded={reasoningExpanded} />
      ) : null}
      <Box flexDirection="column" marginLeft={2}>
        {state.streamingToolCards.filter(isVisibleToolCard).map((card) => (
          <ToolCard
            key={card.id}
            card={card}
            expanded={state.toolsExpandedById[card.id] ?? false}
          />
        ))}
        {state.streamingToolCalls.filter(isVisibleToolCard).map((call) => (
          <ToolCard
            key={call.id}
            card={call}
            expanded={state.toolsExpandedById[call.id] ?? false}
          />
        ))}
      </Box>
      {state.streamingAssistantText !== null ? (
        <AssistantBubble
          text={state.streamingAssistantText}
          streaming
          fusion={fusion}
        />
      ) : null}
    </Box>
  );
}

function ScrollHint({ offset }: { offset: number }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.muted} dimColor>
        ↑ scrolled up {offset} line{offset === 1 ? "" : "s"} — Esc to jump to
        latest
      </Text>
    </Box>
  );
}
