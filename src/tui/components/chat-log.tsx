import { Box, Text, measureElement, type DOMElement } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { computeChatViewportRows } from "../layout.js";
import type { TuiAction } from "../tui-action.js";
import type { ChatMessage, TuiState } from "../tui-state.js";
import { theme } from "../theme/theme.js";
import { AssistantBubble } from "./assistant-bubble.js";
import type { CodingMode } from "../coding-mode.js";
import { ChatCopyButton } from "./chat-copy-button.js";
import { ChatLinkButtons } from "./chat-link-buttons.js";
import { PlanHandoff } from "./plan-handoff.js";
import { ChatTryAgainButton } from "./chat-try-again-button.js";
import {
  estimateMessageHeight,
  estimateStreamingTailHeight,
} from "./chat-message-height.js";
import { ReasoningBubble } from "./reasoning-bubble.js";
import { SplashBanner } from "./splash-banner.js";
import { SystemBubble } from "./system-bubble.js";
import { ThinkingIndicator } from "./thinking-indicator.js";
import { ToolCard } from "./tool-card.js";
import { UserBubble } from "./user-bubble.js";

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
 * Tools whose only "output" is the assistant reply itself. Their tool
 * cards duplicate the `AssistantBubble` body verbatim and add zero
 * information — hide them from the chat surface. The full-fidelity
 * trace still records them.
 */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(["reply"]);

function isVisibleToolCard(card: { tool: string }): boolean {
  return !HIDDEN_TOOL_NAMES.has(card.tool);
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
 * Smooth scroll comes from a single trick: the inner column gets
 * `marginBottom={-state.chatScrollOffset}`, which Yoga interprets as
 * "this box reports its outer height as `intrinsic - offset`". With
 * `flex-end` on the parent, the column visually shifts **down** by
 * `offset` rows — its bottom edge now sits below the viewport, the
 * top edge moves into the viewport, and `overflow: hidden` clips
 * what's left of the bottom. Net effect: the visible window slides
 * up the chat by exactly N rows. One wheel notch = one row.
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
  const showIndicator = state.status === "running";
  const isEmpty = finalised.length === 0 && !hasStreamingTail && !showIndicator;
  // All hooks must run unconditionally — only the JSX branches on
  // `isEmpty`. Compute viewport / measured-K / clamp regardless,
  // even when the early return for the splash branch fires below.
  const viewport = computeChatViewportRows(
    terminalSize.rows,
    terminalSize.columns,
  );
  // First-frame fallback for `K` until the post-mount `measureElement`
  // call returns the truth. Estimates are unreliable (text wraps, Yoga
  // collapses some margins, reasoning blocks expand mid-turn) so we
  // only trust them as a stop-gap for the first paint; after that,
  // `measuredContentRows` is the source of truth.
  const estimatedContentRows = isEmpty
    ? 0
    : finalised.reduce((acc, m) => acc + estimateMessageHeight(m), 0) +
      (hasStreamingTail ? estimateStreamingTailHeight(state) : 0) +
      (showIndicator ? 2 : 0);
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
        <SplashBanner />
      </Box>
    );
  }
  const stickyBottom = offset === 0;
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      justifyContent="flex-end"
      overflow="hidden"
      height={viewport}
    >
      <Box flexDirection="column" flexShrink={0} marginBottom={-offset}>
        <Box ref={innerRef} flexDirection="column" flexShrink={0}>
          {finalised.map((message, idx) => (
            <FinalisedMessage
              key={message.id}
              message={message}
              toolsExpandedById={state.toolsExpandedById}
              // The plan's own buttons, under the plan. Only the last
              // message can carry them: the offer is about the newest
              // plan, and an older one further up the log would be an
              // offer to run something that has already been superseded.
              planHandoff={
                state.planHandoff &&
                idx === finalised.length - 1 &&
                message.role === "assistant" &&
                onPlanExecute !== undefined &&
                onPlanDismiss !== undefined
                  ? { onExecute: onPlanExecute, onDismiss: onPlanDismiss }
                  : null
              }
            />
          ))}
          {hasStreamingTail ? <StreamingTail state={state} /> : null}
          {showIndicator ? <ThinkingIndicator state={state} /> : null}
        </Box>
      </Box>
      {!stickyBottom ? <ScrollHint offset={offset} /> : null}
    </Box>
  );
}

interface FinalisedMessageProps {
  message: ChatMessage;
  toolsExpandedById: Readonly<Record<string, boolean>>;
  /** Present only on the message that *is* the plan. */
  planHandoff: {
    onExecute: (mode: CodingMode) => void;
    onDismiss: () => void;
  } | null;
}

function FinalisedMessage({
  message,
  toolsExpandedById,
  planHandoff,
}: FinalisedMessageProps): ReactElement {
  if (message.role === "user") {
    return (
      <Box flexDirection="column">
        <UserBubble text={message.text} />
        <Box flexDirection="row">
          <ChatCopyButton text={message.text} />
          <ChatTryAgainButton text={message.text} />
          <ChatLinkButtons text={message.text} />
        </Box>
      </Box>
    );
  }
  if (message.role === "assistant") {
    return (
      <Box flexDirection="column">
        {message.reasoningBlocks && message.reasoningBlocks.length > 0 ? (
          <ReasoningBubble
            blocks={message.reasoningBlocks}
            expanded={false}
          />
        ) : null}
        {message.toolCards && message.toolCards.length > 0 ? (
          (() => {
            const visible = message.toolCards.filter(isVisibleToolCard);
            if (visible.length === 0) return null;
            return (
              <Box flexDirection="column" marginLeft={2}>
                {visible.map((card) => (
                  <ToolCard
                    key={card.id}
                    card={card}
                    expanded={toolsExpandedById[card.id] ?? false}
                  />
                ))}
              </Box>
            );
          })()
        ) : null}
        <AssistantBubble
          text={message.text}
          toolSteps={message.toolSteps ?? 0}
        />
        {/* Link chips ride the copy row on user and assistant messages
            only: those carry the URLs someone means to follow. System
            bubbles are TUI runtime output, and their occasional URL is
            documentation, not a destination. */}
        <Box flexDirection="row">
          <ChatCopyButton text={message.text} />
          <ChatLinkButtons text={message.text} />
        </Box>
        {planHandoff ? (
          <PlanHandoff
            onExecute={planHandoff.onExecute}
            onDismiss={planHandoff.onDismiss}
          />
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <SystemBubble
        text={message.text}
        warn={message.variant === "warn"}
      />
      <Box flexDirection="row">
        <ChatCopyButton text={message.text} />
        {/*
          Only the abort notice sets `retryText`, and the button resends
          THAT — the stopped turn's user prompt — not the notice's own
          text. Same shared footer row as every other role, so
          `estimateMessageHeight` stays role-blind.
        */}
        {message.retryText !== undefined ? (
          <ChatTryAgainButton text={message.retryText} />
        ) : null}
      </Box>
    </Box>
  );
}

function StreamingTail({ state }: { state: TuiState }): ReactElement | null {
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
        <AssistantBubble text={state.streamingAssistantText} streaming />
      ) : null}
    </Box>
  );
}

function ScrollHint({ offset }: { offset: number }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.muted} dimColor>
        ↑ scrolled up {offset} line{offset === 1 ? "" : "s"} — Esc to jump to latest
      </Text>
    </Box>
  );
}
