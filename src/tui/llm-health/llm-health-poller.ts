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
const LLM_PROPS_PROBE_TIMEOUT_MS = 2500;

export interface LlmHealthEmitter {
  emit(action: TuiAction): void;
}

/**
 * Owns the always-on llama-server `/health` probe loop that feeds the
 * StatusBar indicator. Runs exactly one probe in flight at a time and
 * survives URL changes via `updateUrl` — the orchestrator calls it from
 * the `llama_url_changed` handler so the indicator follows `/llama`.
 * While the last result was healthy, repeat polls omit the transient
 * `probing` emit so the badge does not flicker between glyphs every interval.
 *
 * After the first healthy `/health` for a given URL the poller also
 * does a one-shot `/props` fetch to discover the active model alias /
 * file name. The result is emitted as `llm_model_updated` so the
 * StatusBar can show the operator which model the agent is talking to.
 * The probe is repeated when the URL changes or when
 * `refreshModelLabel()` is called after a managed daemon restart.
 * Immediate tray updates on catalog selection use `notifyCatalogModel`.
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
   * `probing` emit so the StatusBar glyph does not flicker ●→◐→● every
   * interval. Cleared on URL change or any non-healthy outcome.
   */
  private steadyHealthy = false;
  /**
   * Set once the model label was emitted for the current URL. Reset on
   * `updateUrl` so a hot-swap of the base URL re-discovers the model.
   */
  private modelFetchedForUrl = false;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly emitter: LlmHealthEmitter,
    private url: string,
    private readonly intervalMs: number = LLM_HEALTH_POLL_INTERVAL_MS,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

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
    this.modelFetchedForUrl = false;
    this.emitter.emit({ type: "llm_model_updated", model: null });
    if (!this.stopped) void this.tick();
  }

  /**
   * Immediate label from the Models tab (managed catalog id). Does not
   * block on `/props` — the tray should reflect the operator's choice
   * before the daemon finishes restarting.
   */
  notifyCatalogModel(modelId: string): void {
    if (this.stopped) return;
    this.emitter.emit({ type: "llm_model_updated", model: modelId });
  }

  /**
   * Re-read `/props` after a managed daemon restart or hot-swap so the
   * tray can align with what llama-server reports (when fields exist).
   */
  async refreshModelLabel(): Promise<void> {
    this.modelFetchedForUrl = false;
    if (this.stopped) return;
    await this.fetchModelLabel();
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
        if (!this.modelFetchedForUrl) {
          await this.fetchModelLabel();
        }
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

  private async fetchModelLabel(): Promise<void> {
    const url = new URL("/props", this.url).toString();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      LLM_PROPS_PROBE_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const json = (await response.json()) as Record<string, unknown>;
      const label = extractModelLabel(json);
      // Mark as fetched even when the field is missing so we do not
      // hammer `/props` every tick on older llama.cpp builds.
      this.modelFetchedForUrl = true;
      if (this.stopped) return;
      this.emitter.emit({ type: "llm_model_updated", model: label });
    } catch {
      // Swallow: a one-off `/props` failure must not disturb the
      // health loop. We simply retry on the next URL change.
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Best-effort extraction of a human-friendly model label from the
 * `/props` response. llama.cpp has shipped a few field names over time:
 * `model_alias`, `default_generation_settings.model`, `model_path`. We
 * try them in order and trim the directory portion of any path so the
 * StatusBar can show a compact name.
 */
function extractModelLabel(props: Record<string, unknown>): string | null {
  const candidates: Array<unknown> = [
    props["model_alias"],
    (props["default_generation_settings"] as Record<string, unknown> | undefined)?.[
      "model"
    ],
    (props["default_generation_settings"] as Record<string, unknown> | undefined)?.[
      "model_alias"
    ],
    props["model"],
    props["model_path"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return basename(trimmed);
  }
  return null;
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}
