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
