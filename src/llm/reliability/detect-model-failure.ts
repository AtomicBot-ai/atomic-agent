import type { CompletionResult } from "../llama-server-client.js";
import type { ModelFailureReason } from "./failure-category.js";

export interface DetectedModelFailure {
  reason: ModelFailureReason;
  message: string;
}

/**
 * Inspect a completion for model-side defects that make a retry on the
 * same prompt pointless:
 *
 *  - `truncated`: llama-server flagged the output as cut off (n_predict
 *    exhausted or context overflow). Re-running the same prompt just
 *    reproduces the wall.
 *  - `empty`:     neither `content` nor `reasoningContent` carry usable
 *    text. Most often a misrouted grammar or a model that stopped
 *    immediately after the first token.
 *  - `no_stop`:   the stream ended without the model emitting a stop
 *    token, while the body is still non-empty. Treated as soft evidence
 *    of a cut-off response. Only reported when the content does not
 *    already look like a complete JSON object, to avoid false positives
 *    on fully-parseable outputs that happened to race with stream close.
 *
 * Returns `null` when the completion looks healthy enough to hand off to
 * the grammar parser.
 */
export function detectModelFailure(
  completion: CompletionResult,
): DetectedModelFailure | null {
  if (completion.truncated) {
    return {
      reason: "truncated",
      message: truncatedMessage(completion),
    };
  }
  // The grammar parser runs over `content` only — `reasoningContent` is a
  // CoT sidechannel. A model that thought but never produced a tool-call
  // body counts as empty from the runtime's perspective.
  const trimmedContent = completion.content.trim();
  if (trimmedContent.length === 0) {
    return {
      reason: "empty",
      message: "model returned empty content",
    };
  }
  if (!completion.stop && !looksLikeClosedJsonObject(trimmedContent)) {
    return {
      reason: "no_stop",
      message: "model stream ended without a stop token and output is incomplete",
    };
  }
  return null;
}

function truncatedMessage(completion: CompletionResult): string {
  const predicted = completion.timing?.predictedTokens ?? 0;
  if (predicted > 0) {
    return `model response truncated at ${predicted} tokens`;
  }
  return "model response truncated";
}

/**
 * Cheap structural check — does the content look like it closed a JSON
 * object? Used only as a tie-breaker for `no_stop`: when the content
 * already ends with `}` the parser will either succeed or throw a
 * grammar error, which is the more useful signal.
 */
function looksLikeClosedJsonObject(text: string): boolean {
  if (text.length === 0) return false;
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace === -1) return false;
  return lastBrace >= text.length - 3;
}
