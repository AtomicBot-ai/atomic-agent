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
 *    `call_<n>` with `n` the row's index in the packed turns, so the
 *    same history renders the same ids on every step between cuts;
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
}

export const NO_RESULT_RECORDED = "(no result recorded)";

export function buildNativeMessages(
  prompt: PromptMessages,
  options: NativeMessageOptions,
): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [{ role: "system", content: prompt.system }];
  if (prompt.droppedSummary) {
    out.push({ role: "user", content: prompt.droppedSummary });
  }
  // Calls emitted and still waiting for their `tool` answer, in order.
  let pending: string[] = [];
  // Consecutive orphan result lines, folded into one user message.
  let orphanLines: string[] = [];

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
        answerPending();
        flushOrphans();
        const id = `call_${index}`;
        out.push({
          role: "assistant",
          content: null,
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
        const id = pending.shift();
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
  out.push({ role: "user", content: prompt.tail });
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
