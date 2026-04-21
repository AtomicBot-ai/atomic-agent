import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { ChatMessage, TuiState } from "./tui-state.js";

interface ChatTabProps {
  state: TuiState;
  maxVisible: number;
}

/**
 * Chat transcript view. Shows the most recent N messages so long
 * conversations stay readable in a fixed-height terminal pane. Tool steps
 * are summarised as a single subtle line under each assistant turn —
 * the full step trace stays in the Feed tab.
 */
export function ChatTab({ state, maxVisible }: ChatTabProps): ReactElement {
  const messages = state.messages.slice(-maxVisible);
  if (messages.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">
          (no messages yet — type below and press enter to start chatting)
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} />
      ))}
      {state.status === "running" ? (
        <Text color="yellow">
          assistant is working ({state.currentTurnToolSteps} tool steps so far)…
        </Text>
      ) : null}
    </Box>
  );
}

function ChatBubble({ message }: { message: ChatMessage }): ReactElement {
  if (message.role === "user") {
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>
          you
        </Text>
        <Text>{message.text}</Text>
        <Text> </Text>
      </Box>
    );
  }
  if (message.role === "assistant") {
    return (
      <Box flexDirection="column">
        <Text color="green" bold>
          assistant
          {typeof message.toolSteps === "number" && message.toolSteps > 0
            ? ` · ${message.toolSteps} tool step${message.toolSteps === 1 ? "" : "s"}`
            : ""}
        </Text>
        <Text>{message.text}</Text>
        <Text> </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="gray">{message.text}</Text>
    </Box>
  );
}
