/**
 * Why a model server on this machine turned a request down with a 400
 * (ATO-707, ATO-737), read from the error body's `type`, and the plain
 * words every surface shows for it instead of a bare "http 400".
 *
 * A leaf with no imports, so the OpenAI-compatible HTTP client, the
 * llama-server route and the reliability layer can all read it without
 * a cycle.
 */
export type LocalBadRequestKind = "context_exceeded" | "tools_unsupported" | "invalid_request";

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
 * A server that will not take the request's tools (ATO-1209), in its own
 * words: llama-server started without `--jinja` ("tools param requires
 * --jinja flag", also for `tool_choice`), Ollama's "<model> does not
 * support tools" (sent as a plain string `error`, with no `type`), and
 * the generic "tool(s) not supported" / "tools are not supported".
 * Deliberately not "tool_calls is not supported": that is the native
 * message shape being refused, which the provider already falls back
 * from (`isNativeShapeRejection`).
 */
const TOOLS_UNSUPPORTED_WORDING =
  /\btool(?:s|_choice)?\b[^\n]{0,60}--jinja\b|\bdo(?:es)?(?: not|n't) support tools\b|\btool(?:s|\(s\))?(?: calling| calls?| use)? (?:is |are )?not supported\b/i;

/**
 * The kind of a 400 from a local server, or null for any other status
 * and for a 400 whose body names no reason. A bare 400 with no typed
 * body keeps its old wording, since naming a cause it did not give would
 * be a guess, with one exception: the server's own words that it does
 * not take tools, which Ollama sends with no `type` at all.
 */
export function localBadRequestKind(
  status: number | null,
  type: string | undefined,
  text = "",
): LocalBadRequestKind | null {
  if (status !== 400) return null;
  if (type === EXCEED_CONTEXT_SIZE_TYPE) return "context_exceeded";
  if (TOOLS_UNSUPPORTED_WORDING.test(text)) return "tools_unsupported";
  if (type === INVALID_REQUEST_TYPE) {
    return CONTEXT_FULL_WORDING.test(text) ? "context_exceeded" : "invalid_request";
  }
  return null;
}

/** What happened, in one sentence, per kind. */
export const LOCAL_BAD_REQUEST_SENTENCE: Readonly<Record<LocalBadRequestKind, string>> = {
  context_exceeded:
    "The conversation no longer fits in the local model's context window.",
  tools_unsupported: "This local server doesn't accept tool calls.",
  invalid_request: "The local model server turned the request down as invalid.",
};

/** What to do about it, per kind. No commands: every surface can show it. */
export const LOCAL_BAD_REQUEST_ADVICE: Readonly<Record<LocalBadRequestKind, string>> = {
  context_exceeded:
    "Compact this chat or start a new one, or give the model a larger context size.",
  tools_unsupported: "Start llama-server with --jinja, or pick a model that supports tools.",
  invalid_request:
    "The model or the server may not support something the agent sent, such as tools or images. " +
    "Try another model, or update the server.",
};

/** The tools advice for a server that did not name `--jinja` (Ollama and others). */
export const TOOLS_UNSUPPORTED_MODEL_ADVICE =
  "Pick a model that supports tools, or turn on tool calling in the server.";

/** Only llama-server's own refusal names the flag. */
const JINJA_WORDING = /--jinja\b/i;

/**
 * The advice for a kind, chosen by the server's own words where one
 * sentence does not fit every server: the `--jinja` advice is shown only
 * when the server named that flag, so an Ollama user ("<model> does not
 * support tools") is not told to restart llama-server.
 */
export function localBadRequestAdvice(kind: LocalBadRequestKind, text = ""): string {
  if (kind === "tools_unsupported" && !JINJA_WORDING.test(text)) return TOOLS_UNSUPPORTED_MODEL_ADVICE;
  return LOCAL_BAD_REQUEST_ADVICE[kind];
}
