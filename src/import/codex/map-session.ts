import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import type { SessionState } from "../../session/session-state.js";
import type { CodexBlock, CodexSessionData } from "./codex-source.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const CODEX_SESSION_ID_PREFIX = "codex:";

/**
 * Map one Codex rollout into a native `SessionState`. Pure — no I/O.
 * The projected items fold onto the four-kind `ConversationTurn` model:
 *
 *  - user `text`       → `user` turn (joined).
 *  - assistant `text`  → `assistant_reply`; a `reasoning` summary row
 *    immediately before it rides along as the reply's reasoning.
 *  - `toolCall`        → `assistant_tool_call` (pending reasoning
 *    attaches when no reply claimed it).
 *  - `toolResult`      → `tool_result`, named through the `call_id`
 *    seen on the matching call.
 */
export function mapCodexSession(
  session: CodexSessionData,
  fallbackWorkingDir: string,
): SessionState {
  const turns: ConversationTurn[] = [];
  const toolNames = new Map<string, string>();
  /** A reasoning row waits for the reply or call it belongs to. */
  let pendingReasoning = "";

  for (const message of session.messages) {
    const at = message.atMs;
    if (message.role === "user") {
      const text = joinText(message.blocks);
      if (text.length > 0) turns.push(userTurn(text, at));
      continue;
    }
    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type !== "toolResult") continue;
        turns.push(
          toolResultTurn({
            tool:
              (block.callId !== null
                ? toolNames.get(block.callId)
                : undefined) ?? "unknown",
            status: "ok",
            summary: block.text,
            at,
          }),
        );
      }
      continue;
    }
    // assistant
    const thinking = joinThinking(message.blocks);
    if (thinking.length > 0) {
      pendingReasoning =
        pendingReasoning.length > 0
          ? `${pendingReasoning}\n${thinking}`
          : thinking;
    }
    const text = joinText(message.blocks);
    if (text.length > 0) {
      turns.push(
        assistantReplyTurn(text, {
          at,
          ...(pendingReasoning.length > 0
            ? { reasoning: pendingReasoning }
            : {}),
        }),
      );
      pendingReasoning = "";
    }
    for (const block of message.blocks) {
      if (block.type !== "toolCall") continue;
      if (block.id !== null) toolNames.set(block.id, block.name);
      turns.push(
        assistantToolCallTurn({
          tool: block.name,
          args: block.args,
          at,
          ...(pendingReasoning.length > 0
            ? { reasoning: pendingReasoning }
            : {}),
        }),
      );
      pendingReasoning = "";
    }
  }

  const createdAt =
    session.startedAtMs > 0
      ? session.startedAtMs
      : session.messages.length > 0
        ? session.messages[0]!.atMs
        : 0;
  const lastMessageAt =
    session.messages.length > 0
      ? session.messages[session.messages.length - 1]!.atMs
      : createdAt;
  const turnCount = turns.filter((t) => t.kind === "assistant_reply").length;

  return {
    id: `${CODEX_SESSION_ID_PREFIX}${session.id}`,
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
      importedFrom: "codex",
      codexSessionId: session.id,
    },
  };
}

function joinText(blocks: readonly CodexBlock[]): string {
  return blocks
    .filter((b): b is Extract<CodexBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function joinThinking(blocks: readonly CodexBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<CodexBlock, { type: "thinking" }> =>
        b.type === "thinking",
    )
    .map((b) => b.thinking)
    .join("\n");
}
