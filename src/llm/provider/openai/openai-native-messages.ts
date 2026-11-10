import { estimateTokens } from "../../../prompt/token-budget.js";
import type { PromptMessages, PromptTurn } from "../completion-types.js";

/**
 * The prompt as real chat messages for a native-tools provider.
 *
 * Every cloud request used to be one `user` message holding the stable
 * prefix and the whole history as text — `assistant_tool_call: …` and
 * `tool_result[…]: …` lines. A model that loses the thread of native
 * function calling keeps writing that text instead of calling tools
 * (Gemini Flash did, repeatedly: 84,931 characters in one completion,
 * three worker streams in one run). Laid out as the messages the API
 * defines — `system`, then assistant `tool_calls` answered by `tool`
 * results, then one final `user` message — the history is what the
 * model was trained to continue with a call, and it caches as a prefix
 * that grows by one step per request.
 *
 * Shape rules, all of which exist because the API rejects the request
 * otherwise:
 *  - a `tool` message must answer a `tool_calls` entry by id. Ids are
 *    durable transcript-based IDs in cloud, or `call_<n>` with `n` the
 *    packed row's index in local. Grouped cloud calls share one assistant message;
 *  - a call the history has no result for gets a synthesised
 *    `(no result recorded)` answer before anything else follows it;
 *  - a result whose call the packer cut away has nothing to answer, so
 *    it is carried as the text line the flat form would show, in a
 *    `user` message;
 *  - the packer's dropped-turns recap opens the history as a `user`
 *    message, since it is what stood in for those turns.
 */

export type OpenAiChatMessage = Record<string, unknown>;

export interface NativeMessageOptions {
  /** The adapter's escape for tool names (`os.fs.read` → `os__fs__read`). */
  nameEscape: (qualifiedName: string) => string;
  /**
   * Hand a tool call's reasoning back as the assistant message's
   * `reasoning_content` (ATO-887). Only for a server that renders the
   * model's chat template itself: the template then decides what to keep.
   * The request always ends with a `user` message (the "Respond now"
   * tail), so a plain Qwen3 template, which keeps thinking only after the
   * last user message, still drops it; templates run with
   * `preserve_thinking`, and Flint's, keep it. The total handed back is
   * capped at {@link PRESERVED_REASONING_TOKEN_BUDGET}, since the
   * conversation packer does not count reasoning. Strict APIs answer
   * unknown fields with a 400, so it is off by default.
   */
  preserveReasoning?: boolean;
  /**
   * The service refuses a tool loop unless every assistant `tool_calls`
   * message carries `reasoning_content` (DeepSeek's thinking mode,
   * ATO-1397). Implies `preserveReasoning`, and a call whose reasoning
   * is unknown or was cut by the budget still gets the field, empty.
   */
  requireReasoning?: boolean;
}

/**
 * Most reasoning, in estimated tokens, handed back across all tool calls
 * of one request when `preserveReasoning` is on. The packer budgets the
 * history from calls and results only, so this is headroom the window
 * must spare on top of it; a fixed, small amount keeps a long tool loop
 * on a 16k/32k local window from overflowing the server's context.
 * Newest calls get it first; older reasoning is dropped.
 */
export const PRESERVED_REASONING_TOKEN_BUDGET = 2048;

/**
 * The reasoning each tool call hands back, by turn index, within
 * {@link PRESERVED_REASONING_TOKEN_BUDGET}: walking from the newest call,
 * each one's reasoning is kept whole while it fits; the first that does
 * not is cut from the start, keeping its tail (the part closest to the
 * call), and every older one is dropped.
 */
export function capPreservedReasoning(
  turns: readonly PromptTurn[],
  budget: number = PRESERVED_REASONING_TOKEN_BUDGET,
): Map<number, string> {
  const kept = new Map<number, string>();
  let remaining = budget;
  for (let index = turns.length - 1; index >= 0 && remaining > 0; index--) {
    const turn = turns[index]!;
    if (turn.kind !== "assistant_tool_call") continue;
    const reasoning = turn.reasoning;
    if (reasoning === undefined || reasoning.length === 0) continue;
    const cost = estimateTokens(reasoning);
    if (cost <= remaining) {
      kept.set(index, reasoning);
      remaining -= cost;
      continue;
    }
    const tail = keepTailWithin(reasoning, remaining);
    if (tail.length > 0) kept.set(index, tail);
    break;
  }
  return kept;
}

/** The longest suffix of `text` whose estimate fits in `tokens`. */
function keepTailWithin(text: string, tokens: number): string {
  // estimateTokens is at least chars / 3.6, so this length is an upper bound.
  let length = Math.min(text.length, Math.floor(tokens * 3.6));
  while (length > 0) {
    const tail = text.slice(text.length - length).trimStart();
    if (estimateTokens(tail) <= tokens) return tail;
    length = Math.floor(length * 0.9);
  }
  return "";
}

export const NO_RESULT_RECORDED = "(no result recorded)";

export function buildNativeMessages(
  prompt: PromptMessages,
  options: NativeMessageOptions,
): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [{ role: "system", content: prompt.system }];
  if (prompt.contextSummary) {
    out.push({ role: "user", content: prompt.contextSummary });
  }
  if (prompt.droppedSummary) {
    out.push({ role: "user", content: prompt.droppedSummary });
  }
  // Calls emitted and still waiting for their `tool` answer, in order.
  let pending: string[] = [];
  // Consecutive orphan result lines, folded into one user message.
  let orphanLines: string[] = [];
  const reasoningByTurn =
    options.preserveReasoning === true || options.requireReasoning === true
      ? capPreservedReasoning(prompt.turns)
      : new Map<number, string>();
  const reasoningFor = (index: number): Record<string, unknown> => {
    const kept = reasoningByTurn.get(index);
    if (kept !== undefined) return { reasoning_content: kept };
    return options.requireReasoning === true ? { reasoning_content: "" } : {};
  };

  const flushOrphans = (): void => {
    if (orphanLines.length === 0) return;
    out.push({ role: "user", content: orphanLines.join("\n") });
    orphanLines = [];
  };
  const answerPending = (): void => {
    for (const id of pending) {
      out.push({ role: "tool", tool_call_id: id, content: NO_RESULT_RECORDED });
    }
    pending = [];
  };

  prompt.turns.forEach((turn, index) => {
    switch (turn.kind) {
      case "user":
        answerPending();
        flushOrphans();
        out.push({ role: "user", content: turn.text });
        break;
      case "assistant_reply":
        answerPending();
        flushOrphans();
        out.push({ role: "assistant", content: turn.text });
        break;
      case "assistant_tool_call": {
        if (turn.callId && pending.length > 0 && out[out.length - 1]?.role === "assistant") {
          const previous = out[out.length - 1]!;
          (previous.tool_calls as unknown[]).push({ id: turn.callId, type: "function",
            function: { name: options.nameEscape(turn.tool), arguments: JSON.stringify(turn.args) } });
          pending.push(turn.callId);
          break;
        }
        answerPending();
        flushOrphans();
        const id = turn.callId ?? `call_${index}`;
        out.push({
          role: "assistant",
          content: null,
          ...reasoningFor(index),
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: options.nameEscape(turn.tool),
                arguments: JSON.stringify(turn.args),
              },
            },
          ],
        });
        pending.push(id);
        break;
      }
      case "tool_result": {
        const match = turn.callId ? pending.indexOf(turn.callId) : 0;
        const id = match >= 0 ? pending.splice(match, 1)[0] : undefined;
        if (id === undefined) {
          orphanLines.push(renderOrphanResultLine(turn));
          break;
        }
        flushOrphans();
        out.push({
          role: "tool",
          tool_call_id: id,
          content: renderToolMessageContent(turn),
        });
        break;
      }
    }
  });
  answerPending();
  flushOrphans();
  if (prompt.tail.length > 0) out.push({ role: "user", content: prompt.tail });
  return out;
}

/**
 * What a `tool` message says: the capped body, prefixed with the status
 * when the call failed (the flat line carries it in its header) and
 * suffixed with the truncation note the flat line also carries.
 */
function renderToolMessageContent(
  turn: Extract<PromptTurn, { kind: "tool_result" }>,
): string {
  const body = turn.status === "error" ? `error: ${turn.body}` : turn.body;
  return turn.truncated ? `${body} (truncated)` : body;
}

/** The flat form's line, for a result whose call is out of view. */
function renderOrphanResultLine(
  turn: Extract<PromptTurn, { kind: "tool_result" }>,
): string {
  return `tool_result[${turn.tool} ${turn.status}]: ${turn.body}${
    turn.truncated ? " (truncated)" : ""
  }`;
}

/**
 * A 400 that rejects the message layout itself — roles the server does
 * not accept, an unknown `tool_call_id`, a `messages` array it will not
 * validate — as opposed to a 400 about anything else in the request.
 * Older vLLM builds and llama.cpp shims answer this way; the provider
 * then sends the flat form for the rest of the session.
 */
export function isNativeShapeRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 400) return false;
  return /\brole\b|\broles\b|tool_call_id|tool_calls|\bmessages\b/i.test(
    err.message,
  );
}
