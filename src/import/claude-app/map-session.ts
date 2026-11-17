import {
  assistantReplyTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { macroTurnStartsFromTurns } from "../../session/macro-turn-starts.js";
import type { SessionState } from "../../session/session-state.js";
import type { ClaudeAppConversation } from "./claude-app-source.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const CLAUDE_APP_SESSION_ID_PREFIX = "claude-app:";

/**
 * Map one Claude app conversation into a native `SessionState`. Pure.
 * `human` rows become `user` turns, `assistant` rows `assistant_reply`
 * turns (thinking rides along as reasoning). Attached files are named
 * on the message they came with; their text is not copied, as the
 * export's `extracted_content` can be a whole book.
 */
export function mapClaudeAppConversation(
  conversation: ClaudeAppConversation,
  workingDir: string,
): SessionState {
  const turns: ConversationTurn[] = [];
  for (const m of conversation.messages) {
    const note =
      m.attachments.length > 0 ? `\n\n[Attached: ${m.attachments.join(", ")}]` : "";
    const text = `${m.text}${note}`.trim();
    if (m.role === "user") {
      if (text) turns.push(userTurn(text, m.atMs));
      continue;
    }
    if (!text && !m.reasoning) continue;
    turns.push(
      assistantReplyTurn(text, {
        at: m.atMs,
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      }),
    );
  }
  const first = conversation.messages[0];
  const last = conversation.messages[conversation.messages.length - 1];
  const createdAt = first?.atMs ?? conversation.createdAtMs;
  const updatedAt = Math.max(last?.atMs ?? createdAt, conversation.updatedAtMs);
  return {
    id: `${CLAUDE_APP_SESSION_ID_PREFIX}${conversation.uuid}`,
    workingDir,
    status: "completed",
    knownFacts: [],
    latestResult: null,
    loadedSkills: [],
    loadedTools: [],
    worldSnapshot: null,
    stepCount: 0,
    turnCount: turns.filter((t) => t.kind === "assistant_reply").length,
    macroTurnStarts: macroTurnStartsFromTurns(turns),
    turns,
    createdAt,
    updatedAt,
    lastError: null,
    metadata: {
      importedFrom: "claude-app",
      claudeAppConversationId: conversation.uuid,
      ...(conversation.name !== null ? { title: conversation.name } : {}),
    },
  };
}
