import { buildCloudSubcallRequest } from "../llm/provider/cloud-subcall.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import {
  isStoppedTurnMarker,
  type ConversationTurn,
} from "../session/conversation-turn.js";
import { stripTitleReasoning } from "../session/session-title.js";

/**
 * `/btw <question>` (ATO-1152, ATO-559): a quick question asked beside
 * the main task. The model sees a digest of the conversation so far,
 * answers once with no tools, and nothing about it is written to the
 * session: no turn, no transcript row, no memory. The TUI shows the
 * answer as a notice that is gone after a restart.
 *
 * Partition the call sits in, like `enhance:` / `title:`. The fallback
 * chain keys its breaker state by session id; on the bare id a provider
 * refusing this side question would flip the conversation's own sticky
 * override and reroute its next real step.
 */
export const SIDE_QUESTION_SESSION_PREFIX = "btw:";

/** Partition suffix when no session exists yet (a fresh composer). */
const SIDE_QUESTION_DRAFT_ID = "draft";

/**
 * Deadline for the whole call. The person is waiting on it, and it holds
 * a side-call slot while the main turn may still be running.
 */
export const SIDE_QUESTION_TIMEOUT_MS = 90_000;

/**
 * Output bound. A side question wants a short answer; set here because
 * the main completion path sends no `max_tokens` at all.
 */
export const SIDE_QUESTION_MAX_TOKENS = 2048;

/** Longest question accepted. A wall of text is a task, not an aside. */
export const SIDE_QUESTION_MAX_INPUT_CHARS = 4000;

/**
 * Chars of conversation digest the model is shown, newest first. Kept
 * well under a small local model's context so the side call never
 * fails on length where the main turn would not.
 */
export const SIDE_QUESTION_CONTEXT_BUDGET = 12_000;

/** Per-row clip inside the digest, so one huge paste cannot eat it all. */
const SIDE_QUESTION_ROW_CHARS = 2_000;
/** Tool results are noisy; only their headline goes in. */
const SIDE_QUESTION_TOOL_ROW_CHARS = 200;

export const SIDE_QUESTION_SYSTEM =
  "You answer a quick side question about an ongoing conversation between a user and an AI agent. You cannot run tools. Answer briefly and directly.";

/** Cache key of the rendered prefix; the system message is a constant. */
const SIDE_QUESTION_PREFIX_KEY = "side-question";

export const SIDE_QUESTION_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "The answer to the side question.",
    },
  },
  required: ["answer"],
  additionalProperties: false,
};

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function digestRow(turn: ConversationTurn): string | null {
  switch (turn.kind) {
    case "user":
      return `User: ${clip(turn.text, SIDE_QUESTION_ROW_CHARS)}`;
    case "assistant_reply":
      if (isStoppedTurnMarker(turn)) return "(the user stopped this turn)";
      return `Agent: ${clip(turn.text, SIDE_QUESTION_ROW_CHARS)}`;
    case "assistant_tool_call":
      return `Agent called tool ${turn.tool}`;
    case "tool_result":
      return `Tool ${turn.tool} ${turn.status}: ${clip(turn.summary, SIDE_QUESTION_TOOL_ROW_CHARS)}`;
    default:
      return null;
  }
}

/**
 * The newest rows of the conversation that fit the budget, oldest first.
 * Rows are kept whole or dropped, so the digest never starts mid-row.
 */
export function buildSideQuestionContext(
  turns: readonly ConversationTurn[],
  budget = SIDE_QUESTION_CONTEXT_BUDGET,
): string {
  const rows: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const row = digestRow(turn);
    if (row === null) continue;
    if (used + row.length + 1 > budget) break;
    rows.push(row);
    used += row.length + 1;
  }
  return rows.reverse().join("\n");
}

export function buildSideQuestionPrompt(context: string, question: string): string {
  return [
    context.length > 0
      ? "The conversation so far (newest last, may be shortened):"
      : "There is no conversation yet.",
    ...(context.length > 0 ? ["", context] : []),
    "",
    "The user asks a side question. Answer it using the conversation above and your own knowledge.",
    "Do not continue the agent's task, do not plan tool calls, and do not pretend to have run anything.",
    "If the conversation does not say, say so plainly.",
    "Write in the language the question is written in.",
    "",
    "Side question:",
    question,
  ].join("\n");
}

/**
 * The answer out of a completion, whichever shape it came back in: the
 * synthetic tool's arguments on `native_tools`, else `content`.
 */
export function extractSideAnswerText(
  completion: Pick<CompletionResult, "content" | "toolCalls">,
): string {
  const args = completion.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { answer?: unknown };
      if (typeof parsed.answer === "string" && parsed.answer.trim().length > 0) {
        return parsed.answer.trim();
      }
    } catch {
      // Fall through to the prose answer.
    }
  }
  return stripTitleReasoning(completion.content ?? "").trim();
}

export type SideQuestionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export interface SideQuestionDeps {
  complete: (
    params: CompletionRequest & {
      grammar: string;
      slotId: number;
      sessionId: string;
      signal: AbortSignal;
    },
  ) => Promise<Pick<CompletionResult, "content" | "toolCalls">>;
  slotId: () => number;
  /** The conversation's rows, read once; never written back. */
  turns?: readonly ConversationTurn[];
  toolTransport?: ToolCallTransport;
  /** `false` when `localModels.useServerTemplate` is `"off"`. */
  serverTemplate?: boolean;
  /** The conversation the question was asked in, for the partition key. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Held while running so runtime shutdown can abort it. */
  pending?: Set<AbortController>;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/** Partition key the side question uses for a session (or a fresh composer). */
export function sideQuestionPartition(sessionId: string | undefined): string {
  return `${SIDE_QUESTION_SESSION_PREFIX}${sessionId ?? SIDE_QUESTION_DRAFT_ID}`;
}

/**
 * One answer to a side question. Never throws and never retries, and
 * never touches the session: the turns are only read.
 */
export async function askSideQuestion(
  question: string,
  deps: SideQuestionDeps,
): Promise<SideQuestionResult> {
  const text = question.trim();
  if (text.length === 0) return { ok: false, reason: "nothing to ask" };
  if (text.length > SIDE_QUESTION_MAX_INPUT_CHARS) {
    return {
      ok: false,
      reason: `too long for a side question (over ${SIDE_QUESTION_MAX_INPUT_CHARS} characters)`,
    };
  }
  if (deps.signal?.aborted) return { ok: false, reason: "cancelled" };
  const abort = new AbortController();
  deps.pending?.add(abort);
  const onCallerAbort = (): void => abort.abort();
  deps.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, deps.timeoutMs ?? SIDE_QUESTION_TIMEOUT_MS);
  timer.unref?.();
  try {
    const prompt = buildSideQuestionPrompt(buildSideQuestionContext(deps.turns ?? []), text);
    const result = await deps.complete(buildSideQuestionRequest(prompt, deps, abort.signal));
    const answer = extractSideAnswerText(result);
    if (answer.length === 0) {
      deps.onError?.(new Error("the model returned no answer"));
      return { ok: false, reason: "the model returned no answer" };
    }
    return { ok: true, text: answer };
  } catch (err) {
    deps.onError?.(err);
    if (abort.signal.aborted) {
      return { ok: false, reason: timedOut ? "timed out" : "cancelled" };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    deps.pending?.delete(abort);
  }
}

function buildSideQuestionRequest(
  prompt: string,
  deps: SideQuestionDeps,
  signal: AbortSignal,
): Parameters<SideQuestionDeps["complete"]>[0] {
  const sessionId = sideQuestionPartition(deps.sessionId);
  if (deps.toolTransport === "native_tools") {
    return {
      ...buildCloudSubcallRequest({
        prompt,
        emitFunctionName: "emit_side_answer",
        argsSchema: SIDE_QUESTION_EMIT_SCHEMA,
        description: "Emit the answer to the side question",
        sessionId,
        maxTokens: SIDE_QUESTION_MAX_TOKENS,
      }),
      sessionId,
      grammar: "",
      slotId: -1,
      signal,
    };
  }
  return {
    prompt,
    sessionId,
    grammar: "",
    slotId: deps.slotId(),
    maxTokens: SIDE_QUESTION_MAX_TOKENS,
    signal,
    // Thinking off through the model's own template, as the enhancer and
    // the session namer do: a quick aside should not open a long
    // `<think>` block.
    ...(deps.serverTemplate === false
      ? {}
      : {
          chat: {
            system: SIDE_QUESTION_SYSTEM,
            user: prompt,
            prefixHash: SIDE_QUESTION_PREFIX_KEY,
            enableThinking: false,
          },
        }),
  };
}
