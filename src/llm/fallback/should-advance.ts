import { classifyFailure } from "../reliability/classify-failure.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { LlamaServerError } from "../llama-server-client.js";
import { TransportError } from "../reliability/llm-failures.js";

/**
 * Fallover decision for a single thrown error.
 *
 *  - `advance`: the error indicates the current provider is unavailable
 *    or serving a dead model, so trying the next chain link is worth it.
 *    `false` means the error is deterministic (same request fails the
 *    same way everywhere) or is a cancellation — propagate it untouched.
 *  - `immediate`: an unambiguous provider-down signal (429 / 408 / 5xx /
 *    network-null) that should switch on the FIRST occurrence, bypassing
 *    the consecutive-failure threshold.
 */
export interface AdvanceDecision {
  advance: boolean;
  immediate: boolean;
}

const NO: AdvanceDecision = { advance: false, immediate: false };

/**
 * Map a thrown value onto the fallover decision using the canonical
 * reliability taxonomy plus the typed HTTP status where available.
 *
 * Category rules (see `src/llm/reliability/`):
 *  - `transport` → advance (provider unreachable). Note every cloud
 *    `OpenAiHttpError` classifies as `transport` regardless of status, so
 *    a 404 model-not-found or a 401 dead key advances too — a different
 *    link may have the model or a working key.
 *  - `model` → advance. This is a *defective completion* from a reachable
 *    provider (truncated / empty / no_stop), not "model not found"; the
 *    same prompt would reproduce it here, so another link is worth a try.
 *  - `grammar` / `tool` / `cancelled` → do not advance. A grammar/4xx
 *    failure is request-shape and repeats identically on every provider;
 *    a tool failure is our own bug; a cancellation is user intent.
 *
 * Immediate signals are read off the typed status carried by
 * `OpenAiHttpError` / `LlamaServerError` / `TransportError`: an explicit
 * 429/408, any 5xx, or a network-level null status that is not our own
 * request timeout (`timedOut` — one slow provider is weaker evidence and
 * only counts toward the threshold).
 */
export function shouldAdvance(err: unknown): AdvanceDecision {
  const category = classifyFailure(err);
  if (category !== "transport" && category !== "model") {
    return NO;
  }
  return { advance: true, immediate: isImmediateSignal(err) };
}

function isImmediateSignal(err: unknown): boolean {
  const status = statusOf(err);
  // No typed status field on the error (e.g. a `model`-category
  // ModelError, which carries a reason but no HTTP status) — advance only
  // once the consecutive-failure threshold trips, never immediately.
  if (status === undefined) return false;
  if (status === null) {
    // Network-level failure with no HTTP response, unless it is our own
    // request-timeout controller firing.
    return !timedOutOf(err);
  }
  return status === 429 || status === 408 || status >= 500;
}

function statusOf(err: unknown): number | null | undefined {
  if (err instanceof OpenAiHttpError) return err.status;
  if (err instanceof LlamaServerError) return err.status;
  if (err instanceof TransportError) return err.status;
  return undefined;
}

function timedOutOf(err: unknown): boolean {
  // Both cloud and local clients flag their OWN request-timeout controller
  // firing (status === null). A self-inflicted timeout is weak evidence the
  // provider is down — one slow turn — so it only counts toward the
  // threshold, never an immediate switch. Replaying a local timeout also
  // burns another full timeout of GPU time, so treating it as immediate is
  // doubly wrong. Missing the LlamaServerError arm here silently made local
  // timeouts switch on the first failure, contradicting the doc above.
  if (err instanceof OpenAiHttpError) return err.timedOut;
  if (err instanceof LlamaServerError) return err.timedOut;
  return false;
}
