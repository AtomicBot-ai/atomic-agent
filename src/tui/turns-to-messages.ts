import type { ConversationTurn } from "../session/conversation-turn.js";
import type { ChatMessage, ToolCardEntry } from "./tui-state.js";

/**
 * Rebuild the TUI chat transcript from a persisted session's turn list.
 * Used when switching into an existing session so the operator sees the
 * same `user / assistant / tool` bubbles that were in the live chat when
 * the session was last touched.
 *
 * A macro-turn in the stored list has shape:
 *   user -> (assistant_tool_call + tool_result){0..N} -> assistant_reply?
 * We fold each contiguous slice into one assistant `ChatMessage` carrying
 * its associated tool cards and reasoning blocks.
 *
 * Imported sessions feed this the same list, but their rows come from
 * another agent's store: timestamps are copied verbatim (so two replies
 * can share a millisecond), fields may be missing or of the wrong type,
 * and a row kind this build does not know may appear. The rebuild is
 * therefore defensive — ids are index-qualified so React keys stay
 * unique, values are coerced, unknown kinds are skipped, and a reply
 * with nothing to show is dropped instead of rendering a blank bubble.
 */
export function turnsToMessages(
  turns: readonly ConversationTurn[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingAssistant: MutableAssistant | null = null;
  let toolCounter = 0;
  let lastAt = 0;

  const flushAssistant = (index: number): void => {
    if (!pendingAssistant) return;
    const message = finalizeAssistant(pendingAssistant, index);
    if (message) messages.push(message);
    pendingAssistant = null;
  };

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    const at = asTime(turn.at, lastAt);
    lastAt = at;
    switch (turn.kind) {
      case "user": {
        flushAssistant(i);
        messages.push({
          id: `msg-user-${i}-${at}`,
          role: "user",
          text: asText(turn.text),
          timestamp: at,
        });
        break;
      }
      case "assistant_tool_call": {
        if (!pendingAssistant) pendingAssistant = freshAssistant(at);
        if (turn.reasoning) {
          pendingAssistant.reasoningBlocks.push(asText(turn.reasoning));
        }
        pendingAssistant.pendingCall = {
          id: `tc-${toolCounter++}`,
          stepIndex: pendingAssistant.toolCards.length,
          tool: asText(turn.tool),
          args: turn.args,
          startedAt: at,
        };
        break;
      }
      case "tool_result": {
        if (!pendingAssistant) pendingAssistant = freshAssistant(at);
        const call = pendingAssistant.pendingCall;
        const tool = asText(turn.tool);
        const card: ToolCardEntry = {
          id: call?.id ?? `tc-${toolCounter++}`,
          stepIndex: call?.stepIndex ?? pendingAssistant.toolCards.length,
          tool,
          args: call?.args ?? {},
          status: turn.status,
          summary: asText(turn.summary),
          truncated: Boolean(turn.truncated),
          startedAt: call?.startedAt ?? at,
          finishedAt: at,
        };
        pendingAssistant.toolCards.push(card);
        pendingAssistant.pendingCall = null;
        if (tool !== "reply") pendingAssistant.toolSteps += 1;
        break;
      }
      case "assistant_reply": {
        if (!pendingAssistant) pendingAssistant = freshAssistant(at);
        pendingAssistant.text = asText(turn.text);
        pendingAssistant.timestamp = at;
        if (turn.reasoning) {
          pendingAssistant.reasoningBlocks.push(asText(turn.reasoning));
        }
        flushAssistant(i);
        break;
      }
      default: {
        // A kind this build does not know (a newer store, or an
        // importer's slip). Nothing sensible to draw for it — skip the
        // row rather than throw away the whole transcript.
        const unknown: never = turn;
        void unknown;
        break;
      }
    }
  }
  flushAssistant(turns.length);
  return messages;
}

interface MutableAssistant {
  text: string;
  timestamp: number;
  toolSteps: number;
  toolCards: ToolCardEntry[];
  reasoningBlocks: string[];
  pendingCall: {
    id: string;
    stepIndex: number;
    tool: string;
    args: Record<string, unknown>;
    startedAt: number;
  } | null;
}

function freshAssistant(at: number): MutableAssistant {
  return {
    text: "",
    timestamp: at,
    toolSteps: 0,
    toolCards: [],
    reasoningBlocks: [],
    pendingCall: null,
  };
}

/**
 * Turn the folded slice into a bubble, or `null` when there is nothing
 * to draw: no text, no tool cards, no reasoning. Importers produce such
 * rows for interrupted or content-less assistant messages, and a blank
 * assistant bubble reads as a rendering bug.
 */
function finalizeAssistant(
  a: MutableAssistant,
  index: number,
): ChatMessage | null {
  if (
    a.text.length === 0 &&
    a.toolCards.length === 0 &&
    a.reasoningBlocks.length === 0
  ) {
    return null;
  }
  const base: ChatMessage = {
    // Index-qualified like the user id: `at` alone is not unique on an
    // imported transcript, and `chat-log.tsx` keys rows on this id.
    id: `msg-asst-${index}-${a.timestamp}`,
    role: "assistant",
    text: a.text,
    toolSteps: a.toolSteps,
    timestamp: a.timestamp,
  };
  if (a.toolCards.length > 0) base.toolCards = a.toolCards;
  if (a.reasoningBlocks.length > 0) base.reasoningBlocks = a.reasoningBlocks;
  return base;
}

/** A string for rendering, whatever the stored value turned out to be. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** A usable timestamp; falls back to the previous row's time. */
function asTime(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
