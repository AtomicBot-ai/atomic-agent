import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import type { SessionState } from "../../session/session-state.js";
import type {
  OpenclawBlock,
  OpenclawMessage,
  OpenclawSessionMeta,
} from "./openclaw-source.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const OPENCLAW_SESSION_ID_PREFIX = "openclaw:";

/**
 * Map one OpenClaw session (its header + projected messages) into a native
 * `SessionState`. Pure — no I/O. OpenClaw's event-sourced content blocks
 * are folded onto the four-kind `ConversationTurn` model:
 *
 *  - `user`        → `user` turn (text blocks joined).
 *  - `assistant`   → one `assistant_tool_call` per `toolCall` block (the
 *                    reasoning from `thinking` blocks attaches to the first
 *                    call), or an `assistant_reply` when there are no calls.
 *  - `toolResult`  → `tool_result` turn (`isError` → `status: "error"`).
 */
export function mapOpenclawSession(
  meta: OpenclawSessionMeta,
  messages: readonly OpenclawMessage[],
  fallbackWorkingDir: string,
): SessionState {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    appendMessageTurns(turns, message);
  }

  const createdAt = meta.startedAtMs;
  const lastMessageAt =
    messages.length > 0 ? messages[messages.length - 1]!.atMs : createdAt;
  const turnCount = turns.filter((t) => t.kind === "assistant_reply").length;

  return {
    id: `${OPENCLAW_SESSION_ID_PREFIX}${meta.id}`,
    workingDir: meta.cwd ?? fallbackWorkingDir,
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
      importedFrom: "openclaw",
      openclawSessionId: meta.id,
      ...(meta.model !== null ? { openclawModel: meta.model } : {}),
    },
  };
}

function appendMessageTurns(
  turns: ConversationTurn[],
  message: OpenclawMessage,
): void {
  const at = message.atMs;
  switch (message.role) {
    case "user":
      turns.push(userTurn(joinText(message.blocks), at));
      return;
    case "toolResult":
      turns.push(
        toolResultTurn({
          tool: message.toolName ?? "unknown",
          status: message.isError ? "error" : "ok",
          summary: joinText(message.blocks),
          at,
        }),
      );
      return;
    case "assistant": {
      const reasoning = joinThinking(message.blocks);
      const calls = message.blocks.filter(
        (b): b is Extract<OpenclawBlock, { type: "toolCall" }> =>
          b.type === "toolCall",
      );
      if (calls.length > 0) {
        calls.forEach((call, index) => {
          turns.push(
            assistantToolCallTurn({
              tool: call.name,
              args: call.args,
              at,
              // One inference => one reasoning block; attach to the first call.
              ...(index === 0 && reasoning.length > 0 ? { reasoning } : {}),
            }),
          );
        });
        return;
      }
      turns.push(
        assistantReplyTurn(joinText(message.blocks), {
          at,
          ...(reasoning.length > 0 ? { reasoning } : {}),
        }),
      );
      return;
    }
    default:
      return;
  }
}

/** Concatenate every `text` block, newline-separated. */
function joinText(blocks: readonly OpenclawBlock[]): string {
  return blocks
    .filter((b): b is Extract<OpenclawBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Concatenate every `thinking` block, newline-separated. */
function joinThinking(blocks: readonly OpenclawBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<OpenclawBlock, { type: "thinking" }> =>
        b.type === "thinking",
    )
    .map((b) => b.thinking)
    .join("\n");
}
