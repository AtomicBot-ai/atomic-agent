import { totalmem } from "node:os";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  checkForBackendUpdate,
  DEFAULT_LLAMACPP_MODEL_ID,
  downloadBackend,
  downloadMmproj,
  downloadModel,
  getDaemonStatus,
  getLocalModelDef,
  GithubRateLimitedError,
  isBackendDownloaded,
  isKnownLocalModelId,
  isMmprojDownloaded,
  isModelDownloaded,
  LOCAL_MODELS_CATALOG,
  readBackendVersion,
  readLogTail,
  removeModel,
  resolveChatTemplatePath,
  resolveLogFilePath,
  resolveMmprojFilePath,
  startDaemon,
  stopDaemon,
  type LocalModelDef,
  type LocalModelId,
} from "../../local-llm/index.js";
import type { MmprojStatus } from "./local-models-panel-state.js";
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
        mmprojStatus: resolveMmprojStatus(dataDir, def),
        active:
          cfg.localModels.mode === "managed" &&
          cfg.localModels.managed.modelId === def.id,
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
   * Download a GGUF model and (when applicable) its mmproj projector.
   * If the llama.cpp backend is not yet on disk it is fetched first —
   * users shouldn't need to press a separate key for the backend
   * prerequisite. On success the model is set as the active managed
   * model and the daemon is (re)started so the user lands in a
   * ready-to-chat state.
   *
   * Modes:
   * - `"with-mmproj"` (default for vision-capable rows): pull GGUF then
   *   mmproj sequentially under one download banner. The banner label
   *   updates between phases. If the GGUF is already on disk we skip
   *   straight to the projector phase.
   * - `"gguf-only"` (`g` hotkey): pull the GGUF only, even for
   *   vision-capable models — used when the operator wants a fast
   *   text-only smoke test.
   * - `"mmproj-only"` (Enter on a row whose GGUF is downloaded but
   *   projector is missing): pull the projector only, do not restart
   *   the daemon (operator must restart with `--mmproj` themselves).
   */
  async pullModel(
    id: LocalModelId,
    mode: "with-mmproj" | "gguf-only" | "mmproj-only" = "with-mmproj",
  ): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;

    const def = getLocalModelDef(id);
    if (mode === "mmproj-only" && !def.supportsVision) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ${def.name} is not vision-capable — nothing to pull`,
      });
      return;
    }

    if (mode !== "mmproj-only" && !isBackendDownloaded(dataDir)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: backend missing — downloading llama.cpp first…",
      });
      await this.pullBackend();
      if (!isBackendDownloaded(dataDir)) return;
    }

    if (this.activePullAbort) {
      this.activePullAbort.abort();
    }
    const controller = new AbortController();
    this.activePullAbort = controller;

    try {
      const wantGguf = mode !== "mmproj-only";
      const wantMmproj =
        def.supportsVision && (mode === "with-mmproj" || mode === "mmproj-only");

      if (wantGguf && !isModelDownloaded(dataDir, def)) {
        await this.pullGgufPhase(def, controller.signal);
        if (controller.signal.aborted) return;
      }
      if (wantMmproj && !isMmprojDownloaded(dataDir, def)) {
        await this.pullMmprojPhase(def, controller.signal);
        if (controller.signal.aborted) return;
      }

      this.activePullAbort = null;
      this.bus.emit({ type: "local_models_pull_finished" });

      if (mode === "mmproj-only") {
        await this.refresh();
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: ${def.name} mmproj installed — restart the daemon to enable vision`,
        });
        return;
      }

      persistUserLocalModelsConfig({ mode: "managed", managed: { modelId: id } });
      resetConfigCache();
      await this.refresh();
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ${def.name} installed → starting daemon…`,
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

  /**
   * Phase 1 of a download: pull the GGUF weights. Emits a fresh
   * `pull_started` so the banner shows the GGUF label, then progress
   * events for the GGUF body. The estimated size comes from the
   * catalog so the bar moves even before HTTP `content-length` arrives.
   */
  private async pullGgufPhase(
    def: LocalModelDef,
    signal: AbortSignal,
  ): Promise<void> {
    const dataDir = getConfig().paths.localModelsDataDir;
    const est = Math.round(def.fileSizeGb * (1024 * 1024 * 1024));
    this.bus.emit({
      type: "local_models_pull_started",
      pull: {
        modelId: def.id,
        label: `${def.name} (gguf)`,
        percent: 0,
        transferredBytes: 0,
        totalBytes: est,
        error: null,
      },
    });
    await downloadModel(dataDir, def, {
      signal,
      onProgress: (percent, transferred, total) => {
        this.bus.emit({
          type: "local_models_pull_progress",
          percent,
          transferredBytes: transferred,
          totalBytes: total > 0 ? total : est,
        });
      },
    });
  }

  /**
   * Phase 2 of a download: pull the mmproj projector. Re-emits
   * `pull_started` so the banner label/progress reset to the mmproj
   * file — keeps the UI honest about which file the bar represents.
   */
  private async pullMmprojPhase(
    def: LocalModelDef,
    signal: AbortSignal,
  ): Promise<void> {
    const dataDir = getConfig().paths.localModelsDataDir;
    const est = Math.round(
      (def.mmprojFileSizeGb ?? 1) * (1024 * 1024 * 1024),
    );
    this.bus.emit({
      type: "local_models_pull_started",
      pull: {
        modelId: def.id,
        label: `${def.name} (mmproj)`,
        percent: 0,
        transferredBytes: 0,
        totalBytes: est,
        error: null,
      },
    });
    await downloadMmproj(dataDir, def, {
      signal,
      onProgress: (percent, transferred, total) => {
        this.bus.emit({
          type: "local_models_pull_progress",
          percent,
          transferredBytes: transferred,
          totalBytes: total > 0 ? total : est,
        });
      },
    });
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

  /**
   * Delete a model's on-disk files. If the daemon is currently serving
   * the model we are about to remove, stop it first — otherwise the
   * server keeps the GGUF mmap'd, the next refresh races against a
   * partially-deleted directory, and the operator is left staring at a
   * frozen UI while `rm` churns through gigabytes. Status lines flow
   * into the runtime feed so it is obvious what is happening even
   * though the modal closes immediately.
   */
  async removeLocalModel(id: LocalModelId): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const def = getLocalModelDef(id);
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: removing ${def.name}…`,
    });
    if (
      cfg.localModels.mode === "managed" &&
      cfg.localModels.managed.modelId === id
    ) {
      const st = await getDaemonStatus(
        dataDir,
        cfg.localModels.managed.port,
      );
      if (st.running) {
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: stopping daemon (was serving ${def.name})…`,
        });
        await this.stopDaemon({ silent: true });
      }
    }
    try {
      await removeModel(dataDir, id);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ${def.name} removed`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit({
        type: "local_models_error_set",
        message: `remove failed: ${msg}`,
      });
    } finally {
      await this.refresh();
    }
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
      const mmprojFile =
        cfg.vision.enabled &&
        def.supportsVision &&
        def.mmprojFilename &&
        isMmprojDownloaded(dataDir, def)
          ? resolveMmprojFilePath(dataDir, def.id, def.mmprojFilename)
          : undefined;
      const { pid } = await startDaemon({
        dataDir,
        modelId: mid,
        port: cfg.localModels.managed.port,
        chatTemplateFile: tpl,
        mmprojFile,
      });
      this.daemonSupervised = true;
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ready — pid ${pid} on http://127.0.0.1:${cfg.localModels.managed.port}`,
      });
      if (def.supportsVision) {
        this.bus.emit({
          type: "runtime_info",
          line: mmprojFile
            ? `local-llm: vision enabled (${def.mmprojFilename})`
            : `local-llm: vision disabled — mmproj not downloaded for ${def.id}`,
        });
      }
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

/**
 * Map a model definition + on-disk state to an `MmprojStatus`. Text-only
 * models always return `"n/a"` — keeping the three states distinct in
 * the UI (vs. boolean `mmprojDownloaded`) is what lets the panel render
 * a different glyph for "not applicable" vs "missing".
 */
function resolveMmprojStatus(
  dataDir: string,
  def: LocalModelDef,
): MmprojStatus {
  if (!def.supportsVision) return "n/a";
  return isMmprojDownloaded(dataDir, def) ? "downloaded" : "missing";
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return true;
  const cause = (e as Error & { cause?: unknown }).cause;
  return (
    cause instanceof Error && cause.name === "AbortError"
  );
}
