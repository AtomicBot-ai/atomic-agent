import { checkLlamaServer } from "../../llm/llama-server-health.js";
import type { TuiAction } from "../tui-action.js";

/**
 * Interval between background `/health` probes. Kept short enough that
 * the footer indicator reflects daemon state within a few seconds after a
 * crash / restart, but long enough to avoid hammering a managed daemon
 * that we already launched ourselves. The probe itself uses a tight
 * `retries: 0` + `timeoutMs: 1500` so a down daemon does not stall the
 * loop — one failure immediately flips the indicator to "unreachable".
 */
export const LLM_HEALTH_POLL_INTERVAL_MS = 3000;
const LLM_HEALTH_PROBE_TIMEOUT_MS = 1500;

export interface LlmHealthEmitter {
  emit(action: TuiAction): void;
}

/**
 * Owns the always-on llama-server `/health` probe loop that feeds the
 * footer indicator. Runs exactly one probe in flight at a time and
 * survives URL changes via `updateUrl` — the orchestrator calls it from
 * the `llama_url_changed` handler so the indicator follows `/llama`.
 * While the last result was healthy, repeat polls omit the transient
 * `probing` emit so the badge does not flicker between glyphs every interval.
 *
 * Lifecycle is explicit: the owner calls `start()` on boot and `stop()`
 * on shutdown. This keeps side effects out of the reducer and avoids the
 * hidden-singleton pattern our `AGENTS.md` guide forbids.
 */
export class LlmHealthPoller {
  private timer: NodeJS.Timeout | null = null;
  private probing = false;
  private stopped = false;
  /**
   * After a successful `/health`, follow-up polls skip the transient
   * `probing` emit so the footer glyph does not flicker ●→◐→● every
   * interval. Cleared on URL change or any non-healthy outcome.
   */
  private steadyHealthy = false;

  constructor(
    private readonly emitter: LlmHealthEmitter,
    private url: string,
    private readonly intervalMs: number = LLM_HEALTH_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateUrl(nextUrl: string): void {
    if (nextUrl === this.url) return;
    this.url = nextUrl;
    this.steadyHealthy = false;
    if (!this.stopped) void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.probing || this.stopped) return;
    this.probing = true;
    if (!this.steadyHealthy) {
      this.emitter.emit({
        type: "llm_health_updated",
        status: "probing",
        latencyMs: null,
        error: null,
        checkedAt: Date.now(),
      });
    }
    try {
      const result = await checkLlamaServer({
        url: this.url,
        retries: 0,
        backoffMs: 0,
        timeoutMs: LLM_HEALTH_PROBE_TIMEOUT_MS,
      });
      if (this.stopped) return;
      if (result.reachable) {
        this.steadyHealthy = true;
        this.emitter.emit({
          type: "llm_health_updated",
          status: "healthy",
          latencyMs: result.latencyMs,
          error: null,
          checkedAt: Date.now(),
        });
      } else {
        this.steadyHealthy = false;
        this.emitter.emit({
          type: "llm_health_updated",
          status: "unreachable",
          latencyMs: null,
          error: result.error,
          checkedAt: Date.now(),
        });
      }
    } catch (err) {
      if (this.stopped) return;
      this.steadyHealthy = false;
      const message = err instanceof Error ? err.message : String(err);
      this.emitter.emit({
        type: "llm_health_updated",
        status: "error",
        latencyMs: null,
        error: message,
        checkedAt: Date.now(),
      });
    } finally {
      this.probing = false;
    }
  }
}
