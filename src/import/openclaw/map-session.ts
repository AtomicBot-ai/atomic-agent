import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { macroTurnStartsFromTurns } from "../../session/macro-turn-starts.js";
import type { SessionState } from "../../session/session-state.js";
import {
  OPENCLAW_DEFAULT_AGENT,
  type OpenclawBlock,
  type OpenclawMessage,
  type OpenclawSessionMeta,
} from "./openclaw-source.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const OPENCLAW_SESSION_ID_PREFIX = "openclaw:";

/**
 * `openclaw:<id>` for the default agent — the id every earlier import
 * used, so re-syncs land on the same session — and
 * `openclaw:<agent>:<id>` for any other agent.
 */
export function openclawSessionId(meta: OpenclawSessionMeta): string {
  return meta.agent === OPENCLAW_DEFAULT_AGENT
    ? `${OPENCLAW_SESSION_ID_PREFIX}${meta.id}`
    : `${OPENCLAW_SESSION_ID_PREFIX}${meta.agent}:${meta.id}`;
}

/**
 * Map one OpenClaw session (its header + projected messages) into a native
 * `SessionState`. Pure — no I/O. OpenClaw's event-sourced content blocks
 * are folded onto the four-kind `ConversationTurn` model:
 *
 *  - `user`        → `user` turn (text blocks joined; dropped when empty).
 *  - `assistant`   → `assistant_reply` from the `text` blocks (reasoning
 *                    from `thinking` blocks rides along), then one
 *                    `assistant_tool_call` per `toolCall` block. Without
 *                    text the reasoning attaches to the first call; a
 *                    row with neither text, calls nor reasoning is dropped.
 *  - `toolResult`  → `tool_result` turn (`isError` → `status: "error"`).
 *
 * Macro-turn starts are recorded at every user row so the pairs cap
 * segments the import like a native session.
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
    id: openclawSessionId(meta),
    workingDir: meta.cwd ?? fallbackWorkingDir,
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
      importedFrom: "openclaw",
      openclawSessionId: meta.id,
      openclawAgent: meta.agent,
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
    case "user": {
      const text = joinText(message.blocks);
      if (text.length > 0) turns.push(userTurn(text, at));
      return;
    }
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
      const text = joinText(message.blocks);
      const calls = message.blocks.filter(
        (b): b is Extract<OpenclawBlock, { type: "toolCall" }> =>
          b.type === "toolCall",
      );
      if (text.length > 0 || (calls.length === 0 && reasoning.length > 0)) {
        // The empty-text case is a thinking-only row, which the TUI
        // renders as a reasoning-only message.
        turns.push(
          assistantReplyTurn(text, {
            at,
            ...(reasoning.length > 0 ? { reasoning } : {}),
          }),
        );
      }
      calls.forEach((call, index) => {
        turns.push(
          assistantToolCallTurn({
            tool: call.name,
            args: call.args,
            at,
            // One inference => one reasoning block. It rode the reply
            // when there was one; otherwise it attaches to the first call.
            ...(index === 0 && text.length === 0 && reasoning.length > 0
              ? { reasoning }
              : {}),
          }),
        );
      });
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
