import type { ConversationTurn } from "../session/conversation-turn.js";
import type { ChatMessage, ToolCardEntry } from "./tui-state.js";

/**
 * Rebuild the TUI chat transcript from a persisted session's turn list.
 * Used when switching into an existing session so the operator sees the
 * same `user / assistant / tool` bubbles that were in the live chat when
 * the session was last touched.
 *
 * A macro-turn in the stored list has shape:
 *   user -> (assistant_tool_call + tool_result){0..N} -> assistant_reply?
 * We fold each contiguous slice into one assistant `ChatMessage` carrying
 * its associated tool cards and reasoning blocks.
 */
export function turnsToMessages(
  turns: readonly ConversationTurn[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingAssistant: MutableAssistant | null = null;
  let toolCounter = 0;

  const flushAssistant = (): void => {
    if (!pendingAssistant) return;
    messages.push(finalizeAssistant(pendingAssistant));
    pendingAssistant = null;
  };

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    switch (turn.kind) {
      case "user": {
        flushAssistant();
        messages.push({
          id: `msg-user-${i}-${turn.at}`,
          role: "user",
          text: turn.text,
          timestamp: turn.at,
        });
        break;
      }
      case "assistant_tool_call": {
        if (!pendingAssistant) pendingAssistant = freshAssistant(turn.at);
        if (turn.reasoning) {
          pendingAssistant.reasoningBlocks.push(turn.reasoning);
        }
        pendingAssistant.pendingCall = {
          id: `tc-${toolCounter++}`,
          stepIndex: pendingAssistant.toolCards.length,
          tool: turn.tool,
          args: turn.args,
          startedAt: turn.at,
        };
        break;
      }
      case "tool_result": {
        if (!pendingAssistant) pendingAssistant = freshAssistant(turn.at);
        const call = pendingAssistant.pendingCall;
        const card: ToolCardEntry = {
          id: call?.id ?? `tc-${toolCounter++}`,
          stepIndex: call?.stepIndex ?? pendingAssistant.toolCards.length,
          tool: turn.tool,
          args: call?.args ?? {},
          status: turn.status,
          summary: turn.summary,
          truncated: Boolean(turn.truncated),
          startedAt: call?.startedAt ?? turn.at,
          finishedAt: turn.at,
        };
        pendingAssistant.toolCards.push(card);
        pendingAssistant.pendingCall = null;
        if (turn.tool !== "reply") pendingAssistant.toolSteps += 1;
        break;
      }
      case "assistant_reply": {
        if (!pendingAssistant) pendingAssistant = freshAssistant(turn.at);
        pendingAssistant.text = turn.text;
        pendingAssistant.timestamp = turn.at;
        if (turn.reasoning && turn.reasoning.length > 0) {
          pendingAssistant.reasoningBlocks.push(turn.reasoning);
        }
        flushAssistant();
        break;
      }
    }
  }
  flushAssistant();
  return messages;
}

interface MutableAssistant {
  text: string;
  timestamp: number;
  toolSteps: number;
  toolCards: ToolCardEntry[];
  reasoningBlocks: string[];
  pendingCall: {
    id: string;
    stepIndex: number;
    tool: string;
    args: Record<string, unknown>;
    startedAt: number;
  } | null;
}

function freshAssistant(at: number): MutableAssistant {
  return {
    text: "",
    timestamp: at,
    toolSteps: 0,
    toolCards: [],
    reasoningBlocks: [],
    pendingCall: null,
  };
}

function finalizeAssistant(a: MutableAssistant): ChatMessage {
  const base: ChatMessage = {
    id: `msg-asst-${a.timestamp}`,
    role: "assistant",
    text: a.text,
    toolSteps: a.toolSteps,
    timestamp: a.timestamp,
  };
  if (a.toolCards.length > 0) base.toolCards = a.toolCards;
  if (a.reasoningBlocks.length > 0) base.reasoningBlocks = a.reasoningBlocks;
  return base;
}
