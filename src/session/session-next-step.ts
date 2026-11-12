import { buildCloudSubcallRequest } from "../llm/provider/cloud-subcall.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import type { SessionState, SessionStatus } from "./session-state.js";
import { isFinalReplyTurn, isStoppedTurnMarker } from "./conversation-turn.js";
import { stripTitleReasoning } from "./session-title.js";

/**
 * Next-step suggestion (ATO-1093): after a turn answers, one short side
 * call guesses the message the operator is most likely to send next, so
 * a client can show it greyed out under the reply and accept it with a
 * key press.
 *
 * Built on the session namer's path (`session-title.ts`): the same
 * request shapes for a grammar link and a cloud link, the same
 * reasoning strip, the same fire-and-forget contract. A suggestion is a
 * nicety and must never delay, fail or reroute the turn it follows.
 */

/** Reserved metadata the suggestion is stored under. Runtime-owned. */
export const SESSION_NEXT_STEP_METADATA_KEY = "nextStep";

/** What is stored: the text, and which turn it was written after. */
export interface SessionNextStep {
  text: string;
  /**
   * `turnCount` of the session the suggestion was made for. A later
   * turn moves `turnCount` on, which is how a stale suggestion is told
   * apart from a fresh one without anyone having to clear it.
   */
  afterTurn: number;
  /** Epoch ms the suggestion was stored. */
  at: number;
}

/** Characters a suggestion may take: one line under a reply. */
export const NEXT_STEP_MAX_CHARS = 120;

/**
 * Output bound for the call (the issue's "≤40 tokens"). A suggestion is
 * one short sentence; a model that needs more than this is reasoning,
 * and the answer is dropped rather than paid for at length.
 */
export const NEXT_STEP_MAX_TOKENS = 40;

/** Deadline for the call; only here to free the side-call slot. */
export const NEXT_STEP_TIMEOUT_MS = 15_000;

/**
 * Fallback-chain partition, like `title:`: a provider refusing this
 * request must not flip the turn's own sticky override.
 */
export const NEXT_STEP_SESSION_PREFIX = "next-step:";

/** Chars of the request and of the reply the call is shown. */
export const NEXT_STEP_REQUEST_BUDGET = 800;
export const NEXT_STEP_REPLY_BUDGET = 1500;

/** The model's way of saying there is no sensible follow-up. */
const NO_SUGGESTION = /^(?:none|no suggestion|n\/a|-)$/i;

/** Statuses a session holds while a turn is still in flight. */
const IN_FLIGHT: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "running",
  "awaiting_approval",
  "awaiting_llm",
]);

/** Whether a turn is in flight on a session with this status. */
export function turnInFlight(status: SessionStatus): boolean {
  return IN_FLIGHT.has(status);
}

/**
 * The stored suggestion, or `null` when there is none, it is malformed,
 * or it was made for an earlier turn than the one the session is at.
 * A session with a turn running has no suggestion to show either.
 */
export function readSessionNextStep(
  session: Pick<SessionState, "metadata" | "turnCount" | "status">,
): string | null {
  if (turnInFlight(session.status)) return null;
  const raw = session.metadata?.[SESSION_NEXT_STEP_METADATA_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const stamp = raw as Partial<SessionNextStep>;
  if (typeof stamp.text !== "string" || stamp.text.trim().length === 0) return null;
  if (stamp.afterTurn !== session.turnCount) return null;
  return stamp.text.trim();
}

/**
 * Whether the turn that just ended is one a suggestion makes sense
 * after: the transcript closes on the agent's actual reply. Not after a
 * stop (the user already said what they think of this turn), an
 * interim progress note, or a turn that ended without answering.
 */
export function shouldSuggestNextStep(state: SessionState): boolean {
  const last = state.turns[state.turns.length - 1];
  if (!isFinalReplyTurn(last) || isStoppedTurnMarker(last)) return false;
  if (last.text.trim().length === 0) return false;
  return state.turns.some((turn) => turn.kind === "user");
}

function clip(text: string, budget: number): string {
  return text.length > budget ? `${text.slice(0, budget)}…` : text;
}

/** The last user message and the reply after it, or `null`. */
export function lastExchangeOf(
  state: SessionState,
): { request: string; reply: string } | null {
  let reply: string | null = null;
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const turn = state.turns[i]!;
    if (reply === null) {
      if (isFinalReplyTurn(turn) && !isStoppedTurnMarker(turn)) reply = turn.text;
      continue;
    }
    if (turn.kind === "user") {
      const request = String(turn.text ?? "").trim();
      return request.length > 0 ? { request, reply: reply.trim() } : null;
    }
  }
  return null;
}

/** System message of the templated request. */
export const NEXT_STEP_SYSTEM =
  "You predict the user's next message. Answer with that message alone.";

/** Constant system message, so a constant prefix key is enough. */
const NEXT_STEP_PREFIX_KEY = "session-next-step";

export function buildNextStepPrompt(request: string, reply: string): string {
  return [
    "Below is the last request a user sent to their AI agent and the agent's reply.",
    "",
    "Write the single message the user is most likely to send next: a short, concrete next step.",
    "At most twelve words, written as the user would type it, in the language of the request.",
    "No quotes, no prefix, no explanation. If no follow-up makes sense, answer NONE.",
    "",
    "The request:",
    clip(request, NEXT_STEP_REQUEST_BUDGET),
    "",
    "The reply:",
    clip(reply, NEXT_STEP_REPLY_BUDGET),
  ].join("\n");
}

/**
 * One line, bounded, without decorations, or `null` when the model had
 * nothing (reasoning only, an empty answer, or an explicit `NONE`).
 */
export function sanitizeNextStep(raw: string): string | null {
  let text = stripTitleReasoning(raw);
  // First non-empty line only: a second line is an explanation.
  text = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  // A bullet or heading marker, not emphasis (`*Ship it*` keeps its pair).
  text = text.replace(/^(?:[-*>]\s+|#+\s*)/, "");
  text = text.replace(
    /^[*_]*(?:next(?: step| message)?|suggestion|следующий шаг|подсказка)\s*:\s*[*_]*\s*/i,
    "",
  );
  text = text.replace(/^(\*\*|__|\*|_|`)(.+)\1$/u, "$2").trim();
  text = text.replace(/^["'«“](.*)["'»”]$/u, "$1").trim();
  if (text.length === 0 || NO_SUGGESTION.test(text.replace(/[.!]+$/u, ""))) return null;
  return text.length > NEXT_STEP_MAX_CHARS
    ? `${text.slice(0, NEXT_STEP_MAX_CHARS - 1).trimEnd()}…`
    : text;
}

export const NEXT_STEP_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    next: {
      type: "string",
      description: "The user's likely next message, at most twelve words, or NONE.",
    },
  },
  required: ["next"],
  additionalProperties: false,
};

/** The text out of a completion, from the emit tool or from prose. */
export function extractNextStepText(
  completion: Pick<CompletionResult, "content" | "toolCalls">,
): string {
  const args = completion.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { next?: unknown };
      if (typeof parsed.next === "string") return parsed.next;
    } catch {
      // Fall through to the prose answer.
    }
  }
  return completion.content ?? "";
}

export interface NextStepDeps {
  complete: (
    params: CompletionRequest & {
      grammar: string;
      slotId: number;
      sessionId: string;
    },
  ) => Promise<Pick<CompletionResult, "content" | "toolCalls">>;
  slotId: () => number;
  /** Wire shape of the serving link; see `SessionTitleDeps.toolTransport`. */
  toolTransport?: ToolCallTransport;
  /** See `SessionTitleDeps.serverTemplate`. */
  serverTemplate?: boolean;
  onError?: (err: unknown) => void;
}

/**
 * Ask for a next-step suggestion. `null` on anything going wrong, and
 * on a model that says there is nothing to suggest. Never throws.
 */
export async function generateNextStep(
  state: SessionState,
  deps: NextStepDeps,
): Promise<string | null> {
  const exchange = lastExchangeOf(state);
  if (exchange === null) return null;
  const sessionId = `${NEXT_STEP_SESSION_PREFIX}${state.id}`;
  const text = buildNextStepPrompt(exchange.request, exchange.reply);
  const request =
    deps.toolTransport === "native_tools"
      ? {
          ...buildCloudSubcallRequest({
            prompt: text,
            emitFunctionName: "emit_next_step",
            argsSchema: NEXT_STEP_EMIT_SCHEMA,
            description: "Emit the user's likely next message",
            sessionId,
            maxTokens: NEXT_STEP_MAX_TOKENS,
          }),
          sessionId,
          grammar: "",
          slotId: -1,
        }
      : {
          prompt: text,
          sessionId,
          grammar: "",
          maxTokens: NEXT_STEP_MAX_TOKENS,
          slotId: deps.slotId(),
          ...(deps.serverTemplate === false
            ? {}
            : {
                chat: {
                  system: NEXT_STEP_SYSTEM,
                  user: text,
                  prefixHash: NEXT_STEP_PREFIX_KEY,
                  enableThinking: false,
                },
              }),
        };
  try {
    const result = await deps.complete(request);
    return sanitizeNextStep(extractNextStepText(result));
  } catch (err) {
    deps.onError?.(err);
    return null;
  }
}
