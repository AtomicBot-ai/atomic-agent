import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { macroTurnStartsFromTurns } from "../../session/macro-turn-starts.js";
import type { SessionState } from "../../session/session-state.js";
import type {
  ClaudeCodeBlock,
  ClaudeCodeMessage,
  ClaudeCodeSessionData,
} from "./claude-code-source.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const CLAUDE_CODE_SESSION_ID_PREFIX = "claude-code:";

/**
 * Map one Claude Code transcript into a native `SessionState`. Pure — no
 * I/O. The projected rows fold onto the four-kind `ConversationTurn`
 * model:
 *
 *  - user `text` blocks        → `user` turn (joined).
 *  - user `toolResult` blocks  → one `tool_result` turn each; the tool
 *    name resolves through the `tool_use` id seen on an earlier
 *    assistant row, since Claude Code's result rows carry only the id.
 *  - assistant `text` blocks   → `assistant_reply` (reasoning from
 *    `thinking` blocks rides along); `toolUse` blocks → one
 *    `assistant_tool_call` each. A message with both emits the reply
 *    first, matching the order the blocks were produced in.
 *  - a thinking-only assistant row is carried forward and prepended to
 *    the reasoning of the next assistant row, so it never becomes an
 *    empty reply mid-transcript. It surfaces as a reasoning-only reply
 *    when a user message follows it (an interrupted turn) or when the
 *    transcript ends on it.
 *
 * Macro-turn starts are recorded at every user row so the pairs cap
 * segments the import like a native session.
 */
export function mapClaudeCodeSession(
  session: ClaudeCodeSessionData,
  fallbackWorkingDir: string,
): SessionState {
  const state: MapState = {
    turns: [],
    toolNames: new Map(),
    pendingReasoning: "",
    pendingReasoningAt: 0,
  };
  for (const message of session.messages) {
    appendMessageTurns(state, message);
  }
  flushPendingReasoning(state);
  const { turns } = state;

  const createdAt = session.messages.length > 0 ? session.messages[0]!.atMs : 0;
  const lastMessageAt =
    session.messages.length > 0
      ? session.messages[session.messages.length - 1]!.atMs
      : createdAt;
  const turnCount = turns.filter((t) => t.kind === "assistant_reply").length;

  return {
    id: `${CLAUDE_CODE_SESSION_ID_PREFIX}${session.id}`,
    workingDir: session.cwd ?? fallbackWorkingDir,
    status: "completed",
    knownFacts: [],
    latestResult: null,
    loadedSkills: [],
    loadedTools: [],
    worldSnapshot: null,
    stepCount: 0,
    turnCount,
    macroTurnStarts: macroTurnStartsFromTurns(turns),
    turns,
    createdAt,
    updatedAt: lastMessageAt,
    lastError: null,
    metadata: {
      importedFrom: "claude-code",
      claudeCodeSessionId: session.id,
      ...(session.title !== null ? { title: session.title } : {}),
    },
  };
}

interface MapState {
  turns: ConversationTurn[];
  /** `tool_use` id → tool name, for naming the matching result rows. */
  toolNames: Map<string, string>;
  /** Reasoning from thinking-only rows waiting for the row it belongs to. */
  pendingReasoning: string;
  pendingReasoningAt: number;
}

function appendMessageTurns(state: MapState, message: ClaudeCodeMessage): void {
  const at = message.atMs;
  if (message.role === "user") {
    const text = joinText(message.blocks);
    // A user message after a thinking-only row means the turn was
    // interrupted; the thought belongs before the interruption.
    if (text.length > 0) {
      flushPendingReasoning(state);
      state.turns.push(userTurn(text, at));
    }
    for (const block of message.blocks) {
      if (block.type !== "toolResult") continue;
      state.turns.push(
        toolResultTurn({
          tool:
            (block.toolUseId !== null
              ? state.toolNames.get(block.toolUseId)
              : undefined) ?? "unknown",
          status: block.isError ? "error" : "ok",
          summary: block.text,
          at,
        }),
      );
    }
    return;
  }
  const reasoning = joinNonEmpty(
    state.pendingReasoning,
    joinThinking(message.blocks),
  );
  const text = joinText(message.blocks);
  const calls = message.blocks.filter(
    (b): b is Extract<ClaudeCodeBlock, { type: "toolUse" }> =>
      b.type === "toolUse",
  );
  if (text.length === 0 && calls.length === 0) {
    // Thinking-only row: hold the reasoning for the row that acts on it.
    state.pendingReasoning = reasoning;
    state.pendingReasoningAt = at;
    return;
  }
  state.pendingReasoning = "";
  if (text.length > 0) {
    state.turns.push(
      assistantReplyTurn(text, {
        at,
        ...(reasoning.length > 0 ? { reasoning } : {}),
      }),
    );
  }
  calls.forEach((call, index) => {
    if (call.id !== null) state.toolNames.set(call.id, call.name);
    state.turns.push(
      assistantToolCallTurn({
        tool: call.name,
        args: call.args,
        at,
        // One inference => one reasoning block. It rode the reply when
        // there was one; otherwise it attaches to the first call.
        ...(index === 0 && text.length === 0 && reasoning.length > 0
          ? { reasoning }
          : {}),
      }),
    );
  });
}

/**
 * Surface held reasoning as a reasoning-only reply. The TUI renders an
 * empty reply that carries reasoning as a reasoning block, so nothing
 * the model thought is lost when it never got to act on it.
 */
function flushPendingReasoning(state: MapState): void {
  if (state.pendingReasoning.length === 0) return;
  state.turns.push(
    assistantReplyTurn("", {
      at: state.pendingReasoningAt,
      reasoning: state.pendingReasoning,
    }),
  );
  state.pendingReasoning = "";
}

function joinNonEmpty(first: string, second: string): string {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  return `${first}\n${second}`;
}

function joinText(blocks: readonly ClaudeCodeBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<ClaudeCodeBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

function joinThinking(blocks: readonly ClaudeCodeBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<ClaudeCodeBlock, { type: "thinking" }> =>
        b.type === "thinking",
    )
    .map((b) => b.thinking)
    .join("\n");
}
