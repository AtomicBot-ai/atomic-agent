import { totalmem } from "node:os";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  checkForBackendUpdate,
  DEFAULT_LLAMACPP_MODEL_ID,
  downloadBackend,
  downloadModel,
  getDaemonStatus,
  getLocalModelDef,
  GithubRateLimitedError,
  isBackendDownloaded,
  isKnownLocalModelId,
  isModelDownloaded,
  LOCAL_MODELS_CATALOG,
  readBackendVersion,
  readLogTail,
  removeModel,
  resolveChatTemplatePath,
  resolveLogFilePath,
  startDaemon,
  stopDaemon,
  type LocalModelId,
} from "../../local-llm/index.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import type { TuiEventBus } from "../tui-app.js";

/** Log-tail poll cadence while the LLM logs tab is active. */
const LOGS_POLL_MS = 1000;

/** Snapshot refresh cadence while the Models tab is idle. */
const SNAPSHOT_POLL_MS = 5000;

/**
 * Faster refresh cadence while the user is actively waiting on the
 * daemon to come up. The normal 5s interval is too laggy for the
 * "⟳ starting…" indicator to feel responsive.
 */
const SNAPSHOT_POLL_MS_ACTIVE = 1000;

export class LocalModelsOrchestrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private logsTimer: ReturnType<typeof setInterval> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  /** True while a daemon the TUI owns is running; used by `shutdown()`. */
  private daemonSupervised = false;
  /**
   * In-flight model pull cancellation handle. When the user triggers a
   * second `pullModel(...)` before the first has finished, the orchestrator
   * aborts the running download (tmp file is cleaned up by the file
   * writer's try/finally) and starts the new one.
   */
  private activePullAbort: AbortController | null = null;

  constructor(private readonly bus: TuiEventBus & { emit(action: unknown): void }) {}

  startAutoRefresh(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, SNAPSHOT_POLL_MS);
    void this.refresh();
  }

  startLogsAutoRefresh(): void {
    if (this.logsTimer) return;
    this.logsTimer = setInterval(() => this.readLogsTail(), LOGS_POLL_MS);
    this.readLogsTail();
  }

  stopLogsAutoRefresh(): void {
    if (this.logsTimer) clearInterval(this.logsTimer);
    this.logsTimer = null;
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = null;
    this.stopLogsAutoRefresh();
    // Best-effort tear down the daemon we started. Anything the user
    // launched via `atomic-agent models start` in another terminal has
    // its own pid file and is not our responsibility.
    if (this.daemonSupervised) {
      this.daemonSupervised = false;
      void this.stopDaemonSilent();
    }
  }

  async refresh(): Promise<void> {
    this.bus.emit({ type: "local_models_refresh_started" });
    try {
      const cfg = getConfig();
      const dataDir = cfg.paths.localModelsDataDir;
      const rows = LOCAL_MODELS_CATALOG.map((def) => ({
        id: def.id,
        def,
        downloaded: isModelDownloaded(dataDir, def),
        active: cfg.localModels.mode === "managed" && cfg.localModels.managed.modelId === def.id,
      }));
      const ver = readBackendVersion(dataDir);
      let updateAvailable: boolean | null = null;
      let latestTag: string | null = null;
      try {
        const u = await checkForBackendUpdate(dataDir);
        updateAvailable = u.updateAvailable;
        latestTag = u.latestTag;
      } catch {
        updateAvailable = null;
        latestTag = null;
      }
      const daemon = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
      const activeModelId: LocalModelId | null =
        cfg.localModels.managed.modelId && isKnownLocalModelId(cfg.localModels.managed.modelId)
          ? cfg.localModels.managed.modelId
          : null;
      this.bus.emit({
        type: "local_models_snapshot_loaded",
        rows,
        backend: {
          currentTag: ver?.tag ?? null,
          latestTag,
          updateAvailable,
        },
        daemon: {
          running: daemon.running,
          healthy: daemon.healthy,
          loading: daemon.loading,
          pid: daemon.pid,
          port: daemon.port,
        },
        configMode: cfg.localModels.mode,
        activeModelId,
        totalRamGb: detectHostRamGb(),
        dataDir,
        at: Date.now(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit({ type: "local_models_error_set", message: msg });
    }
  }

  /**
   * Download a GGUF model. If the llama.cpp backend is not yet on disk,
   * it is fetched first — users shouldn't need to press a separate key
   * for the backend prerequisite. On success the model is set as the
   * active managed model and the daemon is (re)started so the user
   * lands in a ready-to-chat state.
   */
  async pullModel(id: LocalModelId): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    if (!isBackendDownloaded(dataDir)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: backend missing — downloading llama.cpp first…",
      });
      await this.pullBackend();
      // pullBackend() emits its own terminal events; bail if still missing.
      if (!isBackendDownloaded(dataDir)) return;
    }
    // Cancel any currently-running pull so the user can switch models
    // without waiting for the first download to finish.
    if (this.activePullAbort) {
      this.activePullAbort.abort();
    }
    const controller = new AbortController();
    this.activePullAbort = controller;

    const m = getLocalModelDef(id);
    const est = Math.round(m.fileSizeGb * (1024 * 1024 * 1024));
    this.bus.emit({
      type: "local_models_pull_started",
      pull: {
        modelId: id,
        label: m.name,
        percent: 0,
        transferredBytes: 0,
        totalBytes: est,
        error: null,
      },
    });
    try {
      await downloadModel(dataDir, m, {
        signal: controller.signal,
        onProgress: (percent, transferred, total) => {
          this.bus.emit({
            type: "local_models_pull_progress",
            percent,
            transferredBytes: transferred,
            totalBytes: total > 0 ? total : est,
          });
        },
      });
      // Superseded by a later pullModel() call — don't finalise or start
      // the daemon, the new call will.
      if (controller.signal.aborted) return;
      this.activePullAbort = null;
      this.bus.emit({ type: "local_models_pull_finished" });
      persistUserLocalModelsConfig({ mode: "managed", managed: { modelId: id } });
      resetConfigCache();
      await this.refresh();
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ${m.name} installed → starting daemon…`,
      });
      if (await this.startDaemon()) {
        this.bus.emit({ type: "ui_mode_set", mode: "chat" });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (this.activePullAbort === controller) this.activePullAbort = null;
      this.bus.emit({ type: "local_models_pull_failed", error: msg });
    }
  }

  async pullBackend(): Promise<void> {
    const dataDir = getConfig().paths.localModelsDataDir;
    this.bus.emit({
      type: "local_models_pull_started",
      pull: {
        modelId: "_backend",
        label: "llama.cpp backend",
        percent: 0,
        transferredBytes: 0,
        totalBytes: 0,
        error: null,
      },
    });
    try {
      await downloadBackend(dataDir, {
        onProgress: (percent, transferred, total) => {
          this.bus.emit({
            type: "local_models_pull_progress",
            percent,
            transferredBytes: transferred,
            totalBytes: total,
          });
        },
      });
      this.bus.emit({ type: "local_models_pull_finished" });
      await this.refresh();
    } catch (e) {
      const msg =
        e instanceof GithubRateLimitedError
          ? `${e.message} Wait a few minutes and try again, or run with GITHUB_TOKEN=…`
          : e instanceof Error
            ? e.message
            : String(e);
      this.bus.emit({ type: "local_models_pull_failed", error: msg });
    }
  }

  /**
   * Persist the active managed model and restart the daemon so the new
   * model is actually served. If the daemon was not running before we
   * still start it — the user's intent in selecting a model is "make
   * this one live".
   */
  async setActive(id: LocalModelId): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    persistUserLocalModelsConfig({ mode: "managed", managed: { modelId: id } });
    resetConfigCache();
    await this.refresh();
    if (!isModelDownloaded(dataDir, getLocalModelDef(id))) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: model ${id} not downloaded — press Enter to pull`,
      });
      return;
    }
    const running = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (running.running) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: restarting daemon for ${id}…`,
      });
      await this.stopDaemon({ silent: true });
    }
    if (await this.startDaemon()) {
      this.bus.emit({ type: "ui_mode_set", mode: "chat" });
    }
  }

  removeLocalModel(id: LocalModelId): void {
    const dataDir = getConfig().paths.localModelsDataDir;
    removeModel(dataDir, id);
    void this.refresh();
  }

  /**
   * Start the daemon for the currently configured managed model. Emits
   * `daemon_phase_set` + runtime info lines so the user sees the
   * transition even before the health probe catches up. Safe to call
   * when the daemon is already running — the underlying `startDaemon`
   * throws and we surface the message.
   *
   * @returns Whether the managed daemon was started successfully (pid acquired).
   */
  async startDaemon(): Promise<boolean> {
    const cfg = getConfig();
    if (cfg.localModels.mode !== "managed") {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: external mode — nothing to start",
      });
      return false;
    }
    const mid = cfg.localModels.managed.modelId;
    if (!mid || !isKnownLocalModelId(mid)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: pick a model first",
      });
      return false;
    }
    const dataDir = cfg.paths.localModelsDataDir;
    const def = getLocalModelDef(mid);
    if (!isBackendDownloaded(dataDir)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: backend missing — downloading…",
      });
      await this.pullBackend();
      if (!isBackendDownloaded(dataDir)) return false;
    }
    if (!isModelDownloaded(dataDir, def)) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: model ${def.name} not downloaded — cannot start`,
      });
      return false;
    }
    this.bus.emit({ type: "local_models_daemon_phase_set", phase: "starting" });
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: starting ${def.name} on port ${cfg.localModels.managed.port}…`,
    });
    this.beginActiveRefresh();
    try {
      const tpl = resolveChatTemplatePath(def) ?? undefined;
      const { pid } = await startDaemon({
        dataDir,
        modelId: mid,
        port: cfg.localModels.managed.port,
        chatTemplateFile: tpl,
      });
      this.daemonSupervised = true;
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ready — pid ${pid} on http://127.0.0.1:${cfg.localModels.managed.port}`,
      });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit({ type: "local_models_daemon_error_set", message: msg });
      this.bus.emit({ type: "runtime_info", line: `local-llm: start failed — ${msg}` });
      return false;
    } finally {
      this.endActiveRefresh();
      await this.refresh();
    }
  }

  async stopDaemon(opts?: { silent?: boolean }): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    this.bus.emit({ type: "local_models_daemon_phase_set", phase: "stopping" });
    if (!opts?.silent) {
      this.bus.emit({ type: "runtime_info", line: "local-llm: stopping daemon…" });
    }
    this.beginActiveRefresh();
    try {
      await stopDaemon(dataDir);
      this.daemonSupervised = false;
      if (!opts?.silent) {
        this.bus.emit({ type: "runtime_info", line: "local-llm: daemon stopped" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit({ type: "local_models_daemon_error_set", message: msg });
      this.bus.emit({ type: "runtime_info", line: `local-llm: stop failed — ${msg}` });
    } finally {
      this.endActiveRefresh();
      await this.refresh();
    }
  }

  /**
   * Silent stop for shutdown paths. No bus events are emitted (the TUI
   * is already unmounting), just the underlying process kill.
   */
  private async stopDaemonSilent(): Promise<void> {
    try {
      await stopDaemon(getConfig().paths.localModelsDataDir, { timeoutMs: 2000 });
    } catch {
      /* best-effort during shutdown */
    }
  }

  /**
   * Called once at TUI startup. If the user is in managed mode AND the
   * backend + model are already on disk AND no daemon is currently
   * running, start the daemon so the user lands in a ready state
   * without needing an extra keypress. No-op otherwise.
   */
  async autoStartIfReady(): Promise<void> {
    const cfg = getConfig();
    if (cfg.localModels.mode !== "managed") return;
    const mid = cfg.localModels.managed.modelId;
    if (!mid || !isKnownLocalModelId(mid)) return;
    const dataDir = cfg.paths.localModelsDataDir;
    if (!isBackendDownloaded(dataDir)) return;
    const def = getLocalModelDef(mid);
    if (!isModelDownloaded(dataDir, def)) return;
    const running = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (running.running) {
      // Already started by a previous TUI session; adopt it.
      this.daemonSupervised = true;
      return;
    }
    await this.startDaemon();
  }

  /**
   * One-click bootstrap for managed mode: download the llama.cpp backend
   * (if missing) and then the target model (defaults to the currently
   * configured managed.modelId, or the recommended catalog default).
   * Emits status lines so the user sees progress in the feed even when
   * the Models tab is not open.
   */
  async ensureAutoInstalled(opts?: { modelId?: LocalModelId }): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const configured = cfg.localModels.managed.modelId;
    const targetId: LocalModelId =
      opts?.modelId ??
      (configured && isKnownLocalModelId(configured)
        ? configured
        : DEFAULT_LLAMACPP_MODEL_ID);
    if (!isBackendDownloaded(dataDir)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: downloading llama.cpp backend…",
      });
      await this.pullBackend();
    }
    const def = getLocalModelDef(targetId);
    if (!isModelDownloaded(dataDir, def)) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: downloading model ${def.name} (${def.sizeLabel})…`,
      });
      await this.pullModel(targetId);
    }
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: targetId },
    });
    resetConfigCache();
    await this.refresh();
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: ready — ${def.name} installed`,
    });
  }

  /** One-line status for slash `/models status` (async, emits to bus). */
  emitStatusLine(): void {
    void (async () => {
      const cfg = getConfig();
      const d = await getDaemonStatus(dataDirOf(cfg), cfg.localModels.managed.port);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: mode=${cfg.localModels.mode} url=${cfg.localModels.url} daemon=${d.running} healthy=${d.healthy}`,
      });
    })();
  }

  private readLogsTail(): void {
    const cfg = getConfig();
    const path = resolveLogFilePath(cfg.paths.localModelsDataDir);
    try {
      const { text, size, truncated } = readLogTail(path);
      this.bus.emit({
        type: "local_llm_logs_loaded",
        text,
        path,
        size,
        truncated,
        at: Date.now(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = msg.includes("ENOENT")
        ? "(log file not yet created — start the daemon first)"
        : msg;
      this.bus.emit({ type: "local_llm_logs_error", message: friendly, path });
    }
  }

  private beginActiveRefresh(): void {
    if (this.activeTimer) return;
    this.activeTimer = setInterval(() => {
      void this.refresh();
    }, SNAPSHOT_POLL_MS_ACTIVE);
  }

  private endActiveRefresh(): void {
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = null;
  }
}

function dataDirOf(cfg: ReturnType<typeof getConfig>): string {
  return cfg.paths.localModelsDataDir;
}

/**
 * Host physical RAM in whole decimal GB (rounded down). Consumers use
 * this to decide which models are realistic candidates on this
 * machine — nothing fancy, just `os.totalmem() / 1e9`.
 */
function detectHostRamGb(): number {
  return Math.max(1, Math.floor(totalmem() / 1_000_000_000));
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return true;
  const cause = (e as Error & { cause?: unknown }).cause;
  return (
    cause instanceof Error && cause.name === "AbortError"
  );
}
