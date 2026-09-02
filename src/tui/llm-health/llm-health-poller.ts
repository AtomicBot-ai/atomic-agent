import { getConfig } from "../../config/index.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { activeTextProviderIsLlamaServer } from "../../llm/provider/registry/active-text-provider.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-registry.js";
import { llamaEndpointUrl } from "../../llm/llama-endpoint-url.js";
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
 * After the first settled result for a URL (healthy OR down/error),
 * repeat polls omit the transient `probing` emit so the badge does not
 * flicker between `probing` and the settled status every interval.
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
   * Once any terminal result (healthy / unreachable / error) has been
   * emitted for the current URL, follow-up polls skip the transient
   * `probing` emit so the badge does not flicker between `probing` and
   * the settled status every interval — this applies to a **down**
   * daemon too (probing→down→probing→down was the visible jitter), not
   * just a healthy one. Reset on URL change so a hot-swap shows `probing`
   * once before the first result lands.
   */
  private hasSettledResult = false;
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
    this.hasSettledResult = false;
    this.modelFetchedForUrl = false;
    this.emitter.emit({
      type: "llm_model_updated",
      model: null,
      contextWindow: null,
    });
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
    // Same gate as `tick`: the Models tab can restart a managed daemon
    // while the route is cloud, and the label this would fetch belongs
    // to a backend that is not serving the session.
    if (!this.localTextActive()) return;
    await this.fetchModelLabel();
  }

  /**
   * Whether the local backend this poller watches is the route the
   * operator is actually on. Read per tick from config rather than
   * latched at construction: the active provider changes from the LLM
   * tab, the composer switch and the provider wizard, and a poller that
   * had to be told about each of them would miss the one that was added
   * last (issue #112).
   */
  private localTextActive(): boolean {
    return activeTextProviderIsLlamaServer(resolveLlmConfig(getConfig()));
  }

  private async tick(): Promise<void> {
    if (this.probing || this.stopped) return;
    // Cloud route: probe nothing and emit nothing. The alternative —
    // poll and hide — still costs a request every 3 s against a server
    // nobody is running, and leaves a `down` reading in state that the
    // context gauge (`select-context-usage`) would read as the active
    // model's window. The interval keeps ticking so a switch back to a
    // local provider resumes within one period, with no start/stop
    // wiring on every switch path.
    if (!this.localTextActive()) return;
    this.probing = true;
    if (!this.hasSettledResult) {
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
        this.hasSettledResult = true;
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
        this.hasSettledResult = true;
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
      this.hasSettledResult = true;
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
    const url = llamaEndpointUrl(this.url, "/props");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      LLM_PROPS_PROBE_TIMEOUT_MS,
    );
    try {
      // Same auth as real requests: llama.cpp guards /props behind
      // --api-key, so an unauthenticated label fetch would leave the
      // footer nameless on exactly the servers that need the key.
      const apiKey = getConfig().localModels.apiKey;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const json = (await response.json()) as Record<string, unknown>;
      const label = extractModelLabel(json);
      const contextWindow = extractContextWindow(json);
      // Mark as fetched even when the field is missing so we do not
      // hammer `/props` every tick on older llama.cpp builds.
      this.modelFetchedForUrl = true;
      if (this.stopped) return;
      this.emitter.emit({ type: "llm_model_updated", model: label, contextWindow });
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

/**
 * Best-effort extraction of the physical context window (`n_ctx`) from
 * the `/props` response. Mirrors the bootstrap `ModelProfile.contextWindow`
 * resolution: prefer `default_generation_settings.n_ctx`, fall back to a
 * root-level `n_ctx`. Returns `null` when neither is a positive number.
 */
function extractContextWindow(props: Record<string, unknown>): number | null {
  const candidates: Array<unknown> = [
    (props["default_generation_settings"] as Record<string, unknown> | undefined)?.[
      "n_ctx"
    ],
    props["n_ctx"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}
