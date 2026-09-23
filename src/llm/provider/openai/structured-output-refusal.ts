import { isRequestSizeRejection } from "../../reliability/request-size-rejection.js";
import { OpenAiHttpError } from "./openai-http.js";

/**
 * Did an endpoint refuse a request because it cannot serve OpenAI
 * Structured Outputs (`response_format: { type: "json_schema" }`)?
 *
 * Only asked about a request whose body actually carried
 * `response_format` — the memory sub-runners' calls (see
 * `sendWithStructuredOutputFallback`). `true` means "the same request
 * without `response_format` is worth one send", nothing more: the caller
 * retries once and remembers the refusal only when that retry is
 * accepted, so a misread body costs one round trip, never a permanent
 * downgrade of a provider that does support the feature.
 *
 * Deliberately narrow, and it fails closed — an unrecognised body is
 * `false` and the provider's error propagates untouched:
 *
 *  - **404** only as OpenRouter's routing refusal: `No endpoints found`
 *    plus evidence that parameter filtering emptied the funnel — the
 *    `requested parameters` sentence (sent under
 *    `provider.require_parameters`), a structured-output field name, or a
 *    `Filter by Parameters` funnel step. When that step's count and the
 *    one before it are both readable and equal, parameters removed
 *    nothing and the funnel was emptied elsewhere (data policy, a pinned
 *    provider order), so it is not a refusal. A bare 404 is a wrong model
 *    id or base URL.
 *  - **400 / 422** whose body names the feature: `response_format`,
 *    `json_schema`, `json_object`, or `structured output(s)`. Excluded:
 *    size rejections (`isRequestSizeRejection` — the request is too big,
 *    and dropping a field does not change that), and the OpenAI/DashScope
 *    `'messages' must contain the word 'json'` 400. That one is a prompt
 *    problem on an endpoint that *does* support structured outputs:
 *    stripping would get the call through, but it would also downgrade
 *    the provider for the rest of the process over a missing word.
 *  - Never 401/402/403/429/5xx, our own timeout, or a network failure
 *    (`status === null`). Those say nothing about the request's shape,
 *    and the retry budget and the fallback chain already own them.
 *
 * The body reaches us as the first 300 characters of the error message
 * (`httpErrorFromResponse`); OpenRouter lists the parameter step second
 * in its funnel, well inside that preview.
 */
export function isStructuredOutputRefusal(
  err: unknown,
): err is OpenAiHttpError {
  if (!(err instanceof OpenAiHttpError) || err.timedOut) return false;
  if (err.status === 404) return isRoutingRefusal(err.message);
  if (err.status !== 400 && err.status !== 422) return false;
  if (JSON_WORD_REQUIRED.test(err.message)) return false;
  if (isRequestSizeRejection(err)) return false;
  return FEATURE_WORDING.test(err.message);
}

const FEATURE_WORDING =
  /response_format|json_schema|json_object|structured[\s_-]*outputs?/i;
const JSON_WORD_REQUIRED = /must contain the word\W+json/i;
const NO_ENDPOINTS = /no endpoints found/i;
const REQUESTED_PARAMETERS = /requested parameters/i;
const PARAMETER_STEP = /filter by parameters/i;
/** The step before `Filter by Parameters`, then that step: two counts. */
const PARAMETER_STEP_COUNTS =
  /"endpoint_count"\s*:\s*(\d+)\s*\}\s*,\s*\{\s*"step"\s*:\s*"Filter by Parameters"\s*,\s*"endpoint_count"\s*:\s*(\d+)/i;

function isRoutingRefusal(text: string): boolean {
  if (!NO_ENDPOINTS.test(text)) return false;
  if (REQUESTED_PARAMETERS.test(text) || FEATURE_WORDING.test(text)) {
    return true;
  }
  if (!PARAMETER_STEP.test(text)) return false;
  const counts = PARAMETER_STEP_COUNTS.exec(text);
  // Unreadable counts (a reshaped funnel, a cut preview): the step's
  // presence is the evidence, and the confirming retry is the backstop.
  if (!counts) return true;
  return Number(counts[2]) < Number(counts[1]);
}
