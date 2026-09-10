/**
 * Canonical taxonomy of failures surfaced by the agent runtime.
 *
 *  - `transport`: the provider link is unusable — llama-server
 *                 unreachable, network error, HTTP 5xx, a llama-server
 *                 4xx that describes the endpoint rather than the request
 *                 (401/402/403/404/405/408/409/429), any cloud HTTP
 *                 failure, or a CLI-backed provider whose binary is
 *                 missing or signed out. Everything here is worth
 *                 retrying on the next link in the fallback chain.
 *  - `grammar`:   the completion payload could not be parsed into a valid
 *                 tool call; also covers the llama-server 4xx statuses
 *                 that reject THIS request as malformed or oversized
 *                 (400/413/422 and any other unlisted 4xx), which the
 *                 next provider would reject identically.
 *  - `model`:     the completion itself is defective (truncated, empty,
 *                 or generated without a stop token). Retrying the same
 *                 prompt is unlikely to help, so the runtime does not.
 *  - `tool`:      an exception thrown while dispatching or executing a
 *                 tool (registry miss, runtime error that escaped the
 *                 tool's own error handling).
 *  - `cancelled`: user or host aborted the ongoing turn. Not a true
 *                 failure, but needs a distinct category so dashboards
 *                 and retry logic do not treat it as one.
 */
export type LlmFailureCategory =
  | "transport"
  | "grammar"
  | "model"
  | "tool"
  | "cancelled";

/**
 * Why a completion was flagged as a model-side defect. Aligned with the
 * three observable failure modes of a grammar-constrained llama-server
 * response.
 */
export type ModelFailureReason = "truncated" | "empty" | "no_stop";

/**
 * Which wall a `truncated` completion hit. Both arrive from the provider
 * as the same `finish_reason: "length"`; the usage block against the cap
 * the request carried is what tells them apart.
 *
 *  - `reply_cap`:      the reply spent the whole `max_tokens` /
 *                      `n_predict` cap — the remedy is a bigger cap.
 *  - `context_window`: the reply stopped short of the cap, so the server
 *                      ran out of context — the remedy is a smaller
 *                      prompt (or a bigger window on the server).
 *  - `output_limit`:   the reply stopped short of the cap while prompt +
 *                      reply sit well inside a window the runtime knows
 *                      — the provider clamps this model's output below
 *                      our cap. Neither a bigger cap nor a smaller prompt
 *                      helps; the cap has to come down to the limit.
 *  - `unknown`:        no usage came back; the walls cannot be told apart.
 */
export type TruncationCause =
  | "reply_cap"
  | "context_window"
  | "output_limit"
  | "unknown";

/** What is known about a truncation, for the message and the retry. */
export interface TruncationDetail {
  cause: TruncationCause;
  /** Reply tokens the model produced before the cut; `0` when unreported. */
  completionTokens: number;
  /** Prompt tokens as the provider counted them; `0` when unreported. */
  promptTokens: number;
  /** The reply cap the request carried; `0` when the caller did not say. */
  requestedMaxTokens: number;
}

/**
 * Which attempt inside a single step raised the model-side defect. A
 * fixed 2-value enum, mirrored verbatim by the error scrubber's
 * allowlist.
 *
 *  - `initial`: the first completion of the step was defective and no
 *               salvage path applied, so the step ended there.
 *  - `repair`:  the first completion was salvageable-looking (or merely
 *               unparseable), the one-shot repair ran, and the repair
 *               completion was defective too.
 *
 * `reason` and `transport` alone cannot recover this split: on
 * `native_tools` an `empty` body with nothing in any channel ends the
 * step at `initial` by design, but a `content`-empty completion that
 * still carries `reasoning_content` is handed to the parser, fails it,
 * routes through the repair, and — when the repair comes back fully
 * empty — raises the identical `reason=empty` + `transport=native_tools`
 * pair at `repair`. Two different stories, one bucket, and the Sentry
 * fingerprint cannot separate them either (it discriminates on a frame
 * *basename*, and the shipped build is a single bundled file).
 */
export type ModelFailureStage = "initial" | "repair";
