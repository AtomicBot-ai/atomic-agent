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
  /**
   * Whether a local backend is the user's actual route, which decides if the
   * indicator is worth showing at all. A fresh install ships a default
   * `localModels.url` nobody chose, so without this the very first probe
   * paints `○ down` about a server that was never meant to exist — noise on
   * the one screen where the user has the least context to judge it.
   *
   * Seeded from config at startup and latched on by a healthy probe, so
   * somebody running llama-server on the default URL without touching config
   * still gets the indicator (and keeps it when their server later dies).
   */
  localConfigured: boolean;
  /**
   * Resident set size of the *managed* llama-server child, sampled by the
   * poller on the same cadence as the `/health` probe (no second timer).
   * `null` whenever there is no managed pid to sample — external mode,
   * daemon down, or a platform without `ps`. Lives in this slice rather
   * than `localModelsPanel.daemon` because that one only refreshes while
   * the Models tab is open, and the composer's status control needs a
   * signal that stays fresh on the home screen.
   */
  daemonRssBytes: number | null;
}

export function createInitialLlmHealthState(
  localConfigured = false,
): LlmHealthState {
  return {
    status: "unknown",
    lastCheckedAt: null,
    latencyMs: null,
    error: null,
    model: null,
    contextWindow: null,
    localConfigured,
    daemonRssBytes: null,
  };
}
