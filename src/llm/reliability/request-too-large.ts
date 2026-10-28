import { LlamaServerError } from "../llama-server-client.js";
import { LlmFailure, type LlmFailureOptions } from "./llm-failures.js";
import {
  isRequestSizeRejection,
  readContextLengthFromRejection,
  requestSizeRejectionNamesContext,
} from "./request-size-rejection.js";

/**
 * A llama-server request refused for its size before any token was
 * generated: the prompt does not fit the context window
 * (`exceed_context_size_error`), or the body is over the server's limit
 * (HTTP 413).
 *
 * It used to be wrapped as `GrammarError`, which is why every
 * "GrammarError" event in error reporting turned out to be a context
 * overflow on `/completion`, with no grammar involved (ATO-422). The
 * class names the real cause; the category stays `grammar`, the bucket
 * the taxonomy reserves for "this request was rejected and would be
 * rejected the same way anywhere": no fallover to the next link, no
 * outage wait, no "start the server" hint, no blind retry of a
 * background task. The overflow compaction in the agent loop finds the
 * `LlamaServerError` on `cause`, exactly as it did under the old
 * wrapper.
 *
 * `message` carries the window when the server named one, so the user
 * reads which limit was hit. Error reporting never sends messages; the
 * event groups on the class name, the category and the cause's
 * `body.type`.
 */
export class RequestTooLargeError extends LlmFailure {
  readonly category = "grammar" as const;

  constructor(
    message: string,
    /** The context window the server named, in tokens, or null. */
    readonly contextWindow: number | null,
    options?: LlmFailureOptions,
    /** The refusal was about the context window (named or not). */
    readonly aboutContext: boolean = contextWindow !== null,
  ) {
    super(message, options);
    this.name = "RequestTooLargeError";
  }
}

/** llama.cpp's `error.type` for a prompt longer than the context window. */
const EXCEED_CONTEXT_SIZE_TYPE = "exceed_context_size_error";

/**
 * Older llama.cpp builds refuse an oversized prompt with this sentence
 * and no typed body. It names neither tokens nor the context, so the
 * generic size wording does not catch it.
 */
const TOO_LARGE_TO_PROCESS = /\btoo large to process\b/i;

/** Below this a "window" is a parsing accident, not a context length. */
const MIN_PLAUSIBLE_WINDOW = 512;

/**
 * Did llama-server refuse THIS request for its size? A 413 always; a
 * 400 when its body says `exceed_context_size_error` or its sentence
 * reads like a size refusal. A 400 about the grammar, or any other 400,
 * is not one.
 */
export function isLlamaSizeRefusal(err: LlamaServerError): boolean {
  if (err.status === 413) return true;
  if (err.status !== 400) return false;
  if (err.body?.type === EXCEED_CONTEXT_SIZE_TYPE) return true;
  return isRequestSizeRejection(err) || TOO_LARGE_TO_PROCESS.test(err.message);
}

/**
 * Wrap a size refusal. The server's own sentence follows ours so the
 * details are still on screen; the window is read the same way the
 * overflow compaction reads it.
 */
export function toRequestTooLargeError(err: LlamaServerError): RequestTooLargeError {
  const named = readContextLengthFromRejection(err);
  const window = named !== null && named >= MIN_PLAUSIBLE_WINDOW ? named : null;
  const aboutContext =
    err.body?.type === EXCEED_CONTEXT_SIZE_TYPE ||
    requestSizeRejectionNamesContext(err);
  const head = window !== null
    ? `The request does not fit the model's context window (${window} tokens).`
    : aboutContext
      ? "The request does not fit the model's context window."
      : "The model server refused the request as too large.";
  return new RequestTooLargeError(`${head} ${err.message}`, window, {
    cause: err,
  }, aboutContext || window !== null);
}
