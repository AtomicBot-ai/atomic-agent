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

/**
 * Whether the rejection talks about the context window at all, as
 * opposed to the reply cap alone. Read by the size-rejection repack:
 * "max_tokens is too large … supports at most 16384 completion tokens"
 * is not fixed by a smaller prompt.
 */
export function requestSizeRejectionNamesContext(error: unknown): boolean {
  return CONTEXT_WORDING.test(messageChain(error));
}

const CONTEXT_WORDING = /context[ _-]?(?:length|window|size)|\bcontext\b/i;

/**
 * The context window the rejection names, in tokens, or null.
 *
 * OpenAI: "This model's maximum context length is 8192 tokens. However,
 * you requested 9134 tokens". OpenRouter: "This endpoint's maximum
 * context length is 131072 tokens. However, you requested about 140000
 * tokens". Others: "context length of only 4096 tokens", "32768-token
 * context window". The number after "requested" is never the window.
 */
export function readContextLengthFromRejection(error: unknown): number | null {
  const text = messageChain(error);
  for (const pattern of CONTEXT_LENGTH_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const value = Number.parseInt(match[1]!.replace(/[,_]/g, ""), 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

const CONTEXT_LENGTH_PATTERNS: readonly RegExp[] = [
  /maximum context length (?:is|of) (\d[\d,_]*) tokens/i,
  /context (?:length|window|size) (?:is|of|:)?\s*(?:only\s+)?(\d[\d,_]*)\s*tokens?/i,
  /(\d[\d,_]*)[- ]token context/i,
  /context (?:length|window|size)[^.\d]{0,40}?(\d[\d,_]*)/i,
];

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
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined;
    depth += 1
  ) {
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
