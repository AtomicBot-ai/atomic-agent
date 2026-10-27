/**
 * Why a model server on this machine turned a request down with a 400
 * (ATO-707, ATO-737), read from the error body's `type`, and the plain
 * words every surface shows for it instead of a bare "http 400".
 *
 * A leaf with no imports, so the OpenAI-compatible HTTP client, the
 * llama-server route and the reliability layer can all read it without
 * a cycle.
 */
export type LocalBadRequestKind = "context_exceeded" | "invalid_request";

/** llama.cpp's `error.type` for a prompt longer than the context window. */
export const EXCEED_CONTEXT_SIZE_TYPE = "exceed_context_size_error";

/** The OpenAI-shape `error.type` for a request the server would not accept. */
export const INVALID_REQUEST_TYPE = "invalid_request_error";

/**
 * Older llama.cpp builds file a prompt that is too long under
 * `invalid_request_error`, with words like "the request exceeds the
 * available context size". Those still mean the context is full.
 */
const CONTEXT_FULL_WORDING =
  /exceeds? (?:the )?(?:available )?context|context (?:size|length|window)[^.]{0,40}(?:exceed|too (?:long|large|small))/i;

/**
 * The kind of a 400 from a local server, or null for any other status
 * and for a 400 whose body names neither reason. A bare 400 with no
 * typed body keeps its old wording: naming a cause it did not give
 * would be a guess.
 */
export function localBadRequestKind(
  status: number | null,
  type: string | undefined,
  text = "",
): LocalBadRequestKind | null {
  if (status !== 400) return null;
  if (type === EXCEED_CONTEXT_SIZE_TYPE) return "context_exceeded";
  if (type === INVALID_REQUEST_TYPE) {
    return CONTEXT_FULL_WORDING.test(text) ? "context_exceeded" : "invalid_request";
  }
  return null;
}

/** What happened, in one sentence, per kind. */
export const LOCAL_BAD_REQUEST_SENTENCE: Readonly<Record<LocalBadRequestKind, string>> = {
  context_exceeded:
    "The conversation no longer fits in the local model's context window.",
  invalid_request: "The local model server turned the request down as invalid.",
};

/** What to do about it, per kind. No commands: every surface can show it. */
export const LOCAL_BAD_REQUEST_ADVICE: Readonly<Record<LocalBadRequestKind, string>> = {
  context_exceeded:
    "Compact this chat or start a new one, or give the model a larger context size.",
  invalid_request:
    "The model or the server may not support something the agent sent, such as tools or images. " +
    "Try another model, or update the server.",
};
