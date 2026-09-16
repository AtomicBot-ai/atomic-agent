import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { macroTurnStartsFromTurns } from "../../session/macro-turn-starts.js";
import type { SessionState } from "../../session/session-state.js";
import type { PiBlock, PiMessage, PiSessionData } from "./pi-session-format.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const PI_SESSION_ID_PREFIX = "pi:";

/**
 * Where a Pi-format session came from. The mapper is shared with the
 * Oh-My-Pi importer, which stamps its own id prefix and metadata so
 * `reconcileImportedSession` keeps the two sources apart.
 */
export interface PiSessionOrigin {
  idPrefix: string;
  importedFrom: string;
  /** Metadata key the source session id is stored under. */
  sessionIdKey: string;
}

const PI_ORIGIN: PiSessionOrigin = {
  idPrefix: PI_SESSION_ID_PREFIX,
  importedFrom: "pi",
  sessionIdKey: "piSessionId",
};

/** Map one Pi transcript into a native `SessionState`. Pure — no I/O. */
export function mapPiSession(
  session: PiSessionData,
  fallbackWorkingDir: string,
): SessionState {
  return mapPiFormatSession(session, fallbackWorkingDir, PI_ORIGIN);
}

/**
 * The shared Pi-format projection onto the four-kind `ConversationTurn`
 * model:
 *
 *  - user `text` blocks       → `user` turn (joined).
 *  - `toolResult` messages    → one `tool_result` turn each; Pi's
 *    result rows carry the tool name, with the `toolCall`-id map as
 *    the fallback for rows that lost it.
 *  - assistant `text` blocks  → `assistant_reply` (reasoning from
 *    `thinking` blocks rides along); `toolCall` blocks → one
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
export function mapPiFormatSession(
  session: PiSessionData,
  fallbackWorkingDir: string,
  origin: PiSessionOrigin,
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
    id: `${origin.idPrefix}${session.id}`,
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
      importedFrom: origin.importedFrom,
      [origin.sessionIdKey]: session.id,
      ...(session.title !== null ? { title: session.title } : {}),
    },
  };
}

interface MapState {
  turns: ConversationTurn[];
  /** `toolCall` id → tool name, for result rows without a `toolName`. */
  toolNames: Map<string, string>;
  /** Reasoning from thinking-only rows waiting for the row it belongs to. */
  pendingReasoning: string;
  pendingReasoningAt: number;
}

function appendMessageTurns(state: MapState, message: PiMessage): void {
  const at = message.atMs;
  if (message.role === "user") {
    const text = joinText(message.blocks);
    // A user message after a thinking-only row means the turn was
    // interrupted; the thought belongs before the interruption.
    if (text.length > 0) {
      flushPendingReasoning(state);
      state.turns.push(userTurn(text, at));
    }
    return;
  }
  if (message.role === "toolResult") {
    for (const block of message.blocks) {
      if (block.type !== "toolResult") continue;
      state.turns.push(
        toolResultTurn({
          tool:
            block.toolName ??
            (block.toolCallId !== null
              ? state.toolNames.get(block.toolCallId)
              : undefined) ??
            "unknown",
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
    (b): b is Extract<PiBlock, { type: "toolCall" }> => b.type === "toolCall",
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

function joinText(blocks: readonly PiBlock[]): string {
  return blocks
    .filter((b): b is Extract<PiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function joinThinking(blocks: readonly PiBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<PiBlock, { type: "thinking" }> => b.type === "thinking",
    )
    .map((b) => b.thinking)
    .join("\n");
}
