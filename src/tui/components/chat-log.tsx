import { Box, Static } from "ink";
import type { ReactElement } from "react";
import type { ChatMessage, TuiState } from "../tui-state.js";
import { AssistantBubble } from "./assistant-bubble.js";
import { ReasoningBubble } from "./reasoning-bubble.js";
import { SplashBanner } from "./splash-banner.js";
import { SystemBubble } from "./system-bubble.js";
import { ToolCard } from "./tool-card.js";
import { UserBubble } from "./user-bubble.js";

interface ChatLogProps {
  state: TuiState;
}

/**
 * Single scrolling chat surface. Finalised messages are rendered through
 * Ink's `<Static>` so they print once and are never redrawn — the
 * flicker-free analogue of openclaw's differential renderer. The live
 * tail (streaming assistant + in-flight tool cards) lives in a normal
 * `<Box>` that re-renders on every state update.
 */
export function ChatLog({ state }: ChatLogProps): ReactElement {
  const finalised = state.messages;
  const isEmpty = finalised.length === 0 && !state.streamingAssistantText;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {isEmpty ? <SplashBanner /> : null}
      <Static items={finalised}>
        {(message) => (
          <FinalisedMessage
            key={message.id}
            message={message}
            toolsExpandedById={state.toolsExpandedById}
          />
        )}
      </Static>
      <StreamingTail state={state} />
    </Box>
  );
}

interface FinalisedMessageProps {
  message: ChatMessage;
  toolsExpandedById: Readonly<Record<string, boolean>>;
}

function FinalisedMessage({
  message,
  toolsExpandedById,
}: FinalisedMessageProps): ReactElement {
  if (message.role === "user") {
    return <UserBubble text={message.text} />;
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
          <Box flexDirection="column" marginLeft={2}>
            {message.toolCards.map((card) => (
              <ToolCard
                key={card.id}
                card={card}
                expanded={toolsExpandedById[card.id] ?? false}
              />
            ))}
          </Box>
        ) : null}
        <AssistantBubble
          text={message.text}
          toolSteps={message.toolSteps ?? 0}
        />
      </Box>
    );
  }
  return <SystemBubble text={message.text} />;
}

function StreamingTail({ state }: { state: TuiState }): ReactElement | null {
  const hasStreaming =
    state.streamingAssistantText !== null ||
    state.streamingToolCalls.length > 0 ||
    state.streamingToolCards.length > 0 ||
    state.reasoning.length > 0;
  if (!hasStreaming) return null;
  const reasoningTexts = state.reasoning.map((r) => r.text);
  // Keep CoT fully visible while the model is still "thinking" (no reply
  // text yet), then collapse it to a one-line summary the moment the
  // final assistant reply starts streaming — so the user's eye follows
  // the answer, not the stale reasoning trail.
  const reasoningExpanded =
    state.streamingAssistantText === null ||
    state.streamingAssistantText.length === 0;
  return (
    <Box flexDirection="column">
      {reasoningTexts.length > 0 ? (
        <ReasoningBubble blocks={reasoningTexts} expanded={reasoningExpanded} />
      ) : null}
      <Box flexDirection="column" marginLeft={2}>
        {state.streamingToolCards.map((card) => (
          <ToolCard
            key={card.id}
            card={card}
            expanded={state.toolsExpandedById[card.id] ?? false}
          />
        ))}
        {state.streamingToolCalls.map((call) => (
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
