import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
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
 */
export function mapClaudeCodeSession(
  session: ClaudeCodeSessionData,
  fallbackWorkingDir: string,
): SessionState {
  const turns: ConversationTurn[] = [];
  /** `tool_use` id → tool name, for naming the matching result rows. */
  const toolNames = new Map<string, string>();
  for (const message of session.messages) {
    appendMessageTurns(turns, message, toolNames);
  }

  const createdAt =
    session.messages.length > 0 ? session.messages[0]!.atMs : 0;
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

function appendMessageTurns(
  turns: ConversationTurn[],
  message: ClaudeCodeMessage,
  toolNames: Map<string, string>,
): void {
  const at = message.atMs;
  if (message.role === "user") {
    const text = joinText(message.blocks);
    if (text.length > 0) turns.push(userTurn(text, at));
    for (const block of message.blocks) {
      if (block.type !== "toolResult") continue;
      turns.push(
        toolResultTurn({
          tool:
            (block.toolUseId !== null
              ? toolNames.get(block.toolUseId)
              : undefined) ?? "unknown",
          status: block.isError ? "error" : "ok",
          summary: block.text,
          at,
        }),
      );
    }
    return;
  }
  const reasoning = joinThinking(message.blocks);
  const text = joinText(message.blocks);
  const calls = message.blocks.filter(
    (b): b is Extract<ClaudeCodeBlock, { type: "toolUse" }> =>
      b.type === "toolUse",
  );
  if (text.length > 0) {
    turns.push(
      assistantReplyTurn(text, {
        at,
        ...(reasoning.length > 0 ? { reasoning } : {}),
      }),
    );
  }
  calls.forEach((call, index) => {
    if (call.id !== null) toolNames.set(call.id, call.name);
    turns.push(
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
  if (text.length === 0 && calls.length === 0 && reasoning.length > 0) {
    // A thinking-only row (interrupted turn): keep the reasoning rather
    // than dropping the message whole.
    turns.push(assistantReplyTurn("", { at, reasoning }));
  }
}

function joinText(blocks: readonly ClaudeCodeBlock[]): string {
  return blocks
    .filter((b): b is Extract<ClaudeCodeBlock, { type: "text" }> => b.type === "text")
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
