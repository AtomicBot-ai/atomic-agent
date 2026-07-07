/**
 * State slice for the footer's llama-server health indicator. Kept
 * separate from `localModelsPanel.daemon` because that one only
 * refreshes while the Models tab is open — the footer needs an
 * always-on signal regardless of which tab the user is viewing.
 *
 * A lightweight background poller in `ChatOrchestrator` pings the
 * configured `localModels.url` every `LLM_HEALTH_POLL_INTERVAL_MS` and
 * dispatches `llm_health_updated` with the latest probe result. The
 * reducer folds it into this slice and the footer component reads from
 * here to render a single-glyph indicator (● healthy, ◐ probing, ○ down,
 * ✕ error).
 */
export type LlmHealthStatus =
  | "unknown"
  | "probing"
  | "healthy"
  | "unreachable"
  | "error";

export interface LlmHealthState {
  status: LlmHealthStatus;
  /** Wall-clock ms of the last probe completion. `null` until first check. */
  lastCheckedAt: number | null;
  /** Round-trip time of the last probe in ms. `null` on first miss. */
  latencyMs: number | null;
  /** Sticky error message from the last failed probe (`null` when healthy). */
  error: string | null;
  /**
   * Active model alias / file name reported by `/props`. The poller
   * fetches this once per URL after the first healthy `/health` probe
   * so the StatusBar can show what the agent is actually talking to.
   * `null` until the first successful `/props` call.
   */
  model: string | null;
  /**
   * Physical context window (`n_ctx`) reported by `/props`, or `null`
   * until the first successful `/props` call / on an older build that
   * does not expose it. Surfaced in the prompt meta-row as `ctx <n>`.
   */
  contextWindow: number | null;
}

export function createInitialLlmHealthState(): LlmHealthState {
  return {
    status: "unknown",
    lastCheckedAt: null,
    latencyMs: null,
    error: null,
    model: null,
    contextWindow: null,
  };
}
