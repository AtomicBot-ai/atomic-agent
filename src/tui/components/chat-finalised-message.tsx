import { Box } from "ink";
import type { ReactElement } from "react";
import type { CodingMode } from "../coding-mode.js";
import type { ChatMessage } from "../tui-state.js";
import { AssistantBubble } from "./assistant-bubble.js";
import { ChatCopyButton } from "./chat-copy-button.js";
import { ChatLinkButtons } from "./chat-link-buttons.js";
import { ChatTryAgainButton } from "./chat-try-again-button.js";
import { PlanHandoff } from "./plan-handoff.js";
import { ReasoningBubble } from "./reasoning-bubble.js";
import { SystemBubble } from "./system-bubble.js";
import { ToolCard } from "./tool-card.js";
import { UserBubble } from "./user-bubble.js";

/**
 * Tools whose only "output" is the assistant reply itself. Their tool
 * cards duplicate the `AssistantBubble` body verbatim and add zero
 * information — hide them from the chat surface. The full-fidelity
 * trace still records them.
 */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(["reply"]);

export function isVisibleToolCard(card: { tool: string }): boolean {
  return !HIDDEN_TOOL_NAMES.has(card.tool);
}

export interface FinalisedMessageProps {
  message: ChatMessage;
  toolsExpandedById: Readonly<Record<string, boolean>>;
  /** Present only on the message that *is* the plan. */
  planHandoff: {
    onExecute: (mode: CodingMode) => void;
    onDismiss: () => void;
  } | null;
  /** Tint the bubbles for the Fusion run mode — see `fusion-tint.ts`. */
  fusion?: boolean;
}

/** One finalised chat message with its footer row, by role. */
export function FinalisedMessage({
  message,
  toolsExpandedById,
  planHandoff,
  fusion = false,
}: FinalisedMessageProps): ReactElement {
  if (message.role === "user") {
    return (
      <Box flexDirection="column">
        <UserBubble text={message.text} fusion={fusion} />
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
          fusion={fusion}
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
