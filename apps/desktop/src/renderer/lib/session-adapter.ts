import type { ConversationTurn, SessionState } from "@agent/session/index.js";

import { isHiddenTool, type ChatMessage, type ToolStep } from "@/chat-types";

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `m${messageSeq}-${Date.now().toString(36)}`;
}

/**
 * Project a persisted `SessionState.turns[]` transcript into the UI's
 * `ChatMessage[]` model. Tool calls / results are folded into the `steps`
 * of the assistant reply that closes their macro-turn; a trailing run of
 * tool steps with no closing reply is attached to a synthetic assistant
 * bubble so in-flight work is still visible after reload.
 */
export function turnsToMessages(
  turns: readonly ConversationTurn[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingSteps: ToolStep[] = [];

  for (const turn of turns) {
    switch (turn.kind) {
      case "user":
        flushPendingSteps(messages, pendingSteps);
        pendingSteps = [];
        messages.push({ id: nextId(), role: "user", text: turn.text });
        break;
      case "assistant_tool_call":
        if (isHiddenTool(turn.tool)) break;
        pendingSteps.push({
          tool: turn.tool,
          args: turn.args,
          status: "running",
        });
        break;
      case "tool_result": {
        if (isHiddenTool(turn.tool)) break;
        const match = [...pendingSteps]
          .reverse()
          .find((s) => s.tool === turn.tool && s.status === "running");
        if (match) {
          match.status = turn.status;
          match.summary = turn.summary;
        } else {
          pendingSteps.push({
            tool: turn.tool,
            status: turn.status,
            summary: turn.summary,
          });
        }
        break;
      }
      case "assistant_reply":
        messages.push({
          id: nextId(),
          role: "assistant",
          text: turn.text,
          reasoning: turn.reasoning,
          steps: pendingSteps.length > 0 ? pendingSteps : undefined,
        });
        pendingSteps = [];
        break;
    }
  }

  flushPendingSteps(messages, pendingSteps);
  return messages;
}

function flushPendingSteps(messages: ChatMessage[], steps: ToolStep[]): void {
  if (steps.length === 0) return;
  messages.push({
    id: nextId(),
    role: "assistant",
    text: "",
    steps: [...steps],
  });
}

export function messageId(): string {
  return nextId();
}

/** Convenience re-export for callers that only need the turns type. */
export type { SessionState };
