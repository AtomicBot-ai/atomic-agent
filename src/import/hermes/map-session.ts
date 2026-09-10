import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { macroTurnStartsFromTurns } from "../../session/macro-turn-starts.js";
import type { SessionState } from "../../session/session-state.js";
import type { HermesMessage, HermesSession } from "./hermes-source.js";

/** Prefix applied to imported session ids so they never collide with native ids. */
export const HERMES_SESSION_ID_PREFIX = "hermes:";

interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Map one Hermes session plus its messages into a native `SessionState`.
 * Pure — no I/O. Roles are projected onto `ConversationTurn`s; REAL
 * second timestamps are converted to integer milliseconds.
 *
 * An assistant row that carries both `content` and `tool_calls` emits
 * the reply first and then one `assistant_tool_call` per call, the way
 * the model produced them; reasoning rides the reply when there is
 * text, else the first call. Macro-turn starts are recorded at every
 * user row so the pairs cap segments the import like a native session.
 */
export function mapHermesSession(
  session: HermesSession,
  messages: readonly HermesMessage[],
  fallbackWorkingDir: string,
): SessionState {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    appendMessageTurns(turns, message);
  }

  const createdAt = secondsToMs(session.startedAtSeconds);
  const lastMessageAt =
    messages.length > 0
      ? secondsToMs(messages[messages.length - 1]!.timestampSeconds)
      : createdAt;
  const turnCount = turns.filter((t) => t.kind === "assistant_reply").length;

  return {
    id: `${HERMES_SESSION_ID_PREFIX}${session.id}`,
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
      importedFrom: "hermes",
      hermesSessionId: session.id,
      ...(session.title !== null ? { title: session.title } : {}),
      ...(session.model !== null ? { hermesModel: session.model } : {}),
    },
  };
}

function appendMessageTurns(
  turns: ConversationTurn[],
  message: HermesMessage,
): void {
  const at = secondsToMs(message.timestampSeconds);
  const reasoning =
    message.reasoning !== null && message.reasoning.length > 0
      ? message.reasoning
      : undefined;

  switch (message.role) {
    case "user": {
      const text = message.content ?? "";
      if (text.length > 0) turns.push(userTurn(text, at));
      return;
    }
    case "tool":
      turns.push(
        toolResultTurn({
          tool: message.toolName ?? "unknown",
          status: "ok",
          summary: message.content ?? "",
          at,
        }),
      );
      return;
    case "assistant": {
      const text = message.content ?? "";
      const calls = parseToolCalls(message.toolCalls);
      if (text.length > 0 || (calls.length === 0 && reasoning !== undefined)) {
        // The empty-text case here is a thinking-only row: the TUI
        // renders it as a reasoning-only message. An assistant row with
        // no text, no calls and no reasoning has nothing to show and is
        // dropped rather than becoming a blank bubble.
        turns.push(
          assistantReplyTurn(text, {
            at,
            ...(reasoning !== undefined ? { reasoning } : {}),
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
            ...(index === 0 && text.length === 0 && reasoning !== undefined
              ? { reasoning }
              : {}),
          }),
        );
      });
      return;
    }
    default:
      // Unknown roles (system, developer, ...) are dropped — they do not
      // map onto the four-kind conversation model.
      return;
  }
}

/**
 * Parse Hermes' `tool_calls` JSON into a list of `{ name, args }`. Shape:
 * `[{ "function": { "name": "...", "arguments": "<json string>" } }]`.
 * Malformed entries are skipped; malformed `arguments` fall back to a
 * `{ _raw }` wrapper so the call is still represented.
 */
function parseToolCalls(raw: string | null): ParsedToolCall[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const calls: ParsedToolCall[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const fn = (entry as { function?: unknown }).function;
    if (!fn || typeof fn !== "object") continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0) continue;
    const args = parseArguments((fn as { arguments?: unknown }).arguments);
    calls.push({ name, args });
  }
  return calls;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw: parsed };
    } catch {
      return { _raw: value };
    }
  }
  return {};
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}
