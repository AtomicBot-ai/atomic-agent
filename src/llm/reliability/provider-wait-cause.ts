import { readErrnoCode } from "../errno-code.js";
import { LlamaServerError } from "../llama-server-client.js";
import {
  isCreditExhausted,
  isErrorFinishMessage,
  OpenAiHttpError,
} from "../provider/openai/openai-http.js";
import { TransportError } from "./llm-failures.js";
import { looksLikeMidStreamDrop } from "./network-error.js";

/**
 * What a parked turn is actually waiting out, in a shape the TUI can
 * word without reading a sentence back.
 *
 * The loop's `reason` is the failure's message, and for a cloud failure
 * that is already a finished sentence (`humanizeOpenAiHttpError`). Put
 * inside another sentence it said things that were not true: a stream
 * the provider ended with `finish_reason: "error"` is typed with a
 * status so the loop parks on it, and came out as "server trouble
 * (502). Tried 3 times" for a 200 that was never retried. Each kind
 * here carries only facts the error itself holds — a status only when
 * a response had one.
 *
 * `billing` is a provider that answered and refused because the account
 * cannot pay (`isCreditExhausted`: a 402, AI/ML API's 403 "You've run out
 * of funds", OpenAI's 429 `insufficient_quota`). A turn never waits on
 * one; it is the cause of a link that failed before the one waited on,
 * and of an error that ended the turn.
 */
export type ProviderWaitCause =
  | { readonly kind: "billing"; readonly status: number }
  | { readonly kind: "refused" }
  | { readonly kind: "dropped" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "timeout" }
  | { readonly kind: "loading" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "stream_error"; readonly status: number | null }
  | { readonly kind: "error_finish" }
  | { readonly kind: "unknown" };

/** A chain link that failed before the one a turn waits on, and why. */
export interface ProviderWaitFailure {
  readonly providerId: string;
  /** The failure's own line (`describeReason`), for logs and traces. */
  readonly reason: string;
  readonly cause: ProviderWaitCause;
}

const MAX_CAUSE_DEPTH = 6;

const UNREACHABLE_ERRNOS = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT",
]);

const DROPPED_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

const TIMEOUT_ERRNOS = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** llama.cpp's answer while the weights are still being read. */
const LOADING_MODEL = /\bloading model\b/i;

export function classifyProviderWaitCause(err: unknown): ProviderWaitCause {
  const chain = causeChain(err);

  // A failure reported inside an open stream: most specific, and the
  // one whose `status` must not be taken for a response status.
  for (const link of chain) {
    if (link instanceof OpenAiHttpError && link.streamError !== undefined) {
      if (isErrorFinishMessage(link.streamError)) return { kind: "error_finish" };
      return { kind: "stream_error", status: link.status };
    }
  }

  // An account that cannot pay, read off the provider's own error under
  // whatever wrapper reached here: the step executor's TransportError
  // carries the status alone.
  for (const link of chain) {
    if (
      link instanceof OpenAiHttpError &&
      !link.timedOut &&
      link.status !== null &&
      isCreditExhausted(link)
    ) {
      return { kind: "billing", status: link.status };
    }
  }

  for (const link of chain) {
    if (
      link instanceof OpenAiHttpError ||
      link instanceof LlamaServerError
    ) {
      if (link.timedOut) return { kind: "timeout" };
      if (link.status !== null) return statusCause(link.status, link.message);
      break;
    }
    if (link instanceof TransportError && link.status !== null) {
      return statusCause(link.status, link.message);
    }
  }

  const errno = readErrnoCode(err);
  if (errno === "ECONNREFUSED") return { kind: "refused" };
  if (errno !== undefined && DROPPED_ERRNOS.has(errno)) return { kind: "dropped" };
  if (errno !== undefined && TIMEOUT_ERRNOS.has(errno)) return { kind: "timeout" };
  if (errno !== undefined && UNREACHABLE_ERRNOS.has(errno)) {
    return { kind: "unreachable" };
  }

  for (const link of chain) {
    if (!(link instanceof Error)) continue;
    if (looksLikeMidStreamDrop(link.message)) return { kind: "dropped" };
    if (/^fetch failed$/i.test(link.message.trim())) {
      return { kind: "unreachable" };
    }
  }
  return { kind: "unknown" };
}

function statusCause(status: number, message: string): ProviderWaitCause {
  if (status === 503 && LOADING_MODEL.test(message)) return { kind: "loading" };
  return { kind: "http", status };
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if (chain.includes(current)) break;
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}
