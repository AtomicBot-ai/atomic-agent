import { LlamaServerError } from "../llama-server-client.js";
import { llamaLegacyPortNote } from "../llama-default-port-note.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import {
  LOCAL_BAD_REQUEST_ADVICE,
  LOCAL_BAD_REQUEST_SENTENCE,
  localBadRequestKind,
  type LocalBadRequestKind,
} from "../provider/openai/local-bad-request.js";
import { isLocalProviderUrl } from "../provider/presets/is-local-provider-url.js";

/**
 * Machine-readable reasons a turn on a local model server failed with an
 * HTTP answer (ATO-708, ATO-873, ATO-737). Hosts branch on them the way
 * they branch on `local_engine_down`: the desktop shows a "Reconnect"
 * button for `local_server_not_found`, a terminal prints the recheck
 * command.
 *
 *  - `local_server_not_found`: the llama.cpp route (managed or External)
 *    answered 404/405. Something listens there, but it is not a model
 *    server, or no model is loaded behind the route.
 *  - `local_context_exceeded`: a local server answered 400 because the
 *    conversation outgrew the model's context window.
 *  - `local_request_invalid`: a local server answered 400 with
 *    `invalid_request_error` for anything else.
 */
export const LOCAL_SERVER_NOT_FOUND_CODE = "local_server_not_found";
export const LOCAL_CONTEXT_EXCEEDED_CODE = "local_context_exceeded";
export const LOCAL_REQUEST_INVALID_CODE = "local_request_invalid";

export type LocalServerErrorCode =
  | typeof LOCAL_SERVER_NOT_FOUND_CODE
  | typeof LOCAL_CONTEXT_EXCEEDED_CODE
  | typeof LOCAL_REQUEST_INVALID_CODE;

/** The sentence every surface shows for `local_server_not_found` (ATO-708). */
export const LOCAL_SERVER_NOT_FOUND_MESSAGE =
  "This address isn't a model server, or the model isn't loaded there.";

/** What a surface with no Reconnect button says under it. */
export const LOCAL_SERVER_NOT_FOUND_ADVICE =
  "Check that the model server runs at this address with a model loaded.";

/** The terminal's recheck command (ATO-873, variant B). */
export const LOCAL_SERVER_RECHECK_COMMAND = "atomic-agent models check";

/** What a terminal adds under a `local_server_not_found` failure. */
export const LOCAL_SERVER_RECHECK_HINT = `Recheck the address with: ${LOCAL_SERVER_RECHECK_COMMAND}`;

/** A failed turn's local-server reason, with the words for it. */
export interface LocalServerError {
  readonly code: LocalServerErrorCode;
  readonly status: 400 | 404 | 405;
  /** The URL the failed request went to. Never sent off the machine. */
  readonly url: string;
  /** What happened, one plain sentence. */
  readonly message: string;
  /**
   * What to do, with no commands in it, so every surface can show it.
   * For an address on 8080, the old llama.cpp default, it names 9931.
   */
  readonly advice: string;
}

/** Depth cap on the `cause` walk; longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

const BAD_REQUEST_CODE: Readonly<Record<LocalBadRequestKind, LocalServerErrorCode>> = {
  context_exceeded: LOCAL_CONTEXT_EXCEEDED_CODE,
  invalid_request: LOCAL_REQUEST_INVALID_CODE,
};

/**
 * The local-server reason behind a failed turn, or null.
 *
 * Walks the `cause` chain because the agent loop wraps the HTTP error
 * (`toLlmFailure` keeps it on `cause`). The first typed HTTP error found
 * decides:
 *
 *  - `LlamaServerError` is the llama.cpp route by definition. A 404/405
 *    is `local_server_not_found`; a 400 whose body names its reason is
 *    one of the two 400 codes.
 *  - `OpenAiHttpError` counts only for a URL on this machine, and only
 *    for a typed 400. Its 404/405 already has a sentence of its own
 *    (ATO-871), and the Reconnect check probes the llama.cpp address,
 *    not an OpenAI-compatible provider's, so it gets no code here.
 *
 * A failure reported inside an open stream, a timeout, a bare 400 with
 * no reason in its body and every other status return null: their
 * wording stays what it was.
 */
export function classifyLocalServerError(err: unknown): LocalServerError | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof LlamaServerError) return fromLlamaError(current);
    if (current instanceof OpenAiHttpError) return fromOpenAiError(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function fromLlamaError(err: LlamaServerError): LocalServerError | null {
  if (err.timedOut) return null;
  if (err.status === 404 || err.status === 405) {
    return {
      code: LOCAL_SERVER_NOT_FOUND_CODE,
      status: err.status === 404 ? 404 : 405,
      url: err.url,
      message: LOCAL_SERVER_NOT_FOUND_MESSAGE,
      advice: llamaLegacyPortNote(err.url) ?? LOCAL_SERVER_NOT_FOUND_ADVICE,
    };
  }
  return badRequest(err.status, err.body?.type, err.message, err.url);
}

function fromOpenAiError(err: OpenAiHttpError): LocalServerError | null {
  if (err.timedOut || err.streamError !== undefined) return null;
  if (!isLocalProviderUrl(err.url)) return null;
  return badRequest(err.status, err.body?.type, err.body?.text ?? err.message, err.url);
}

function badRequest(
  status: number | null,
  type: string | undefined,
  text: string,
  url: string,
): LocalServerError | null {
  const kind = localBadRequestKind(status, type, text);
  if (kind === null) return null;
  return {
    code: BAD_REQUEST_CODE[kind],
    status: 400,
    url,
    message: LOCAL_BAD_REQUEST_SENTENCE[kind],
    advice: LOCAL_BAD_REQUEST_ADVICE[kind],
  };
}

/**
 * The lines a terminal prints for a classified failure: the sentence,
 * the advice, and for `local_server_not_found` the recheck command.
 * Unindented; each caller indents to its own layout.
 */
export function localServerErrorLines(error: LocalServerError): string[] {
  const lines = [`${error.message} ${error.advice}`];
  if (error.code === LOCAL_SERVER_NOT_FOUND_CODE) lines.push(LOCAL_SERVER_RECHECK_HINT);
  return lines;
}
