/**
 * Canonical taxonomy of failures surfaced by the agent runtime.
 *
 *  - `transport`: llama-server unreachable, network error, HTTP 5xx.
 *  - `grammar`:   the completion payload could not be parsed into a valid
 *                 tool call; also covers HTTP 4xx from llama-server which
 *                 generally means the server rejected the grammar or
 *                 request shape.
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
