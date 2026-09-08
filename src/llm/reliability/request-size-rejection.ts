import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { TransportError } from "./llm-failures.js";

/**
 * Did the provider refuse the request for its *size* — a 400 or 413
 * whose wording names the reply cap or the context length?
 *
 * Such a rejection is deterministic: the same request is too big for
 * this model, and it will be too big on the next link of the fallback
 * chain too (the local llama-server behind a cloud primary usually has
 * the smaller window). Two callers read it:
 *
 *  - `shouldAdvance` keeps the chain where it is, instead of falling
 *    over to a link that may not even be running and parking the turn
 *    on the outage wait.
 *  - The agent loop, when the rejected request was its own truncation
 *    retry with a raised cap, fails the turn with the truncation that
 *    started it — which names the knob — rather than with "rejected the
 *    request (400)".
 *
 * Wording is matched over the error's `cause` chain, because the chat
 * message (`humanizeOpenAiHttpError`) drops the provider's body text and
 * keeps it on the cause.
 */
export function isRequestSizeRejection(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== 400 && status !== 413) return false;
  const text = messageChain(error);
  return SIZE_FIELD_WORDING.test(text) && SIZE_VERDICT_WORDING.test(text);
}

/**
 * Both halves must match. The field name alone is not enough: OpenAI's
 * o-series answers `Unsupported parameter: 'max_tokens' is not supported
 * with this model. Use 'max_completion_tokens' instead.` — a body-shape
 * rejection another link may well accept, which must keep falling over.
 */
const SIZE_FIELD_WORDING =
  /max_tokens|max_completion_tokens|context[ _-]?(?:length|window|size)|tokens/i;
const SIZE_VERDICT_WORDING =
  /too large|too long|too many|exceed|maximum|at most|greater than|limit|reduce/i;

function statusOf(error: unknown): number | null | undefined {
  if (error instanceof OpenAiHttpError) return error.status;
  if (error instanceof LlamaServerError) return error.status;
  if (error instanceof TransportError) return error.status;
  return undefined;
}

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}
