import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
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
  const reasoning = message.reasoning ?? undefined;

  switch (message.role) {
    case "user":
      turns.push(userTurn(message.content ?? "", at));
      return;
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
      const calls = parseToolCalls(message.toolCalls);
      if (calls.length > 0) {
        calls.forEach((call, index) => {
          turns.push(
            assistantToolCallTurn({
              tool: call.name,
              args: call.args,
              at,
              // One inference => one reasoning block; attach to the first call.
              ...(index === 0 && reasoning !== undefined
                ? { reasoning }
                : {}),
            }),
          );
        });
        return;
      }
      // Plain assistant reply (may also carry an empty content string).
      turns.push(
        assistantReplyTurn(message.content ?? "", {
          at,
          ...(reasoning !== undefined ? { reasoning } : {}),
        }),
      );
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
