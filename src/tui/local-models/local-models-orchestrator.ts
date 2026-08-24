import { totalmem } from "node:os";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { addCustomModel, removeCustomModel } from "../../config/custom-models-store.js";
import { hasOtherLiveSessions } from "../../local-llm/session-registry.js";
import {
  checkForBackendUpdate,
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_LLAMACPP_MODEL_ID,
  downloadBackend,
  downloadEmbeddingModel,
  downloadMmproj,
  downloadModel,
  EMBEDDING_MODELS_CATALOG,
  getDaemonStatus,
  getEmbeddingDaemonStatus,
  getEmbeddingModelDef,
  getLocalModelDef,
  GithubRateLimitedError,
  isBackendDownloaded,
  isEmbeddingModelDownloaded,
  isKnownEmbeddingModelId,
  isKnownLocalModelId,
  isMmprojDownloaded,
  isModelDownloaded,
  buildCustomModelDef,
  listLocalModels,
  listVulkanDevices,
  maybeAutoUpdateBackend,
  probeNvidiaVramMiB,
  readBackendVersion,
  readLogTail,
  removeEmbeddingModel as removeEmbeddingModelFiles,
  removeModel,
  resolveChatTemplatePath,
  resolveEmbeddingLogFilePath,
  resolveGpuBudgetGb,
  resolveLogFilePath,
  resolveManagedDevice,
  resolveMmprojFilePath,
  resolvePlatformAsset,
  resolveHuggingFaceGgufChoices,
  resolveServerBinPath,
  startChatAndEmbeddingDaemons,
  startEmbeddingDaemon,
  stopChatAndEmbeddingDaemons,
  stopDaemon as stopChatDaemonProcess,
  stopEmbeddingDaemon,
  type EmbeddingDaemonStartOptions,
  type EmbeddingModelDef,
  type EmbeddingModelId,
  type GpuDevice,
  type HuggingFaceRepoChoices,
  type LocalModelDef,
  type LocalModelId,
} from "../../local-llm/index.js";
import {
  classifyVramFit,
  estimateModelVramNeedGb,
  type EmbeddingDaemonInfo,
  type EmbeddingModelRow,
  type MmprojStatus,
} from "./local-models-panel-state.js";
import {
  persistEmbeddingHybridRecall,
  persistMemoryEmbeddingsEnabled,
} from "../persist-embedding-hybrid-recall.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { ChatPullMirror, downloadProgressFor } from "../local-turn-gate.js";
import type { TuiEventBus } from "../tui-app.js";

/**
 * Human-readable summary of how the configured device preference
 * resolved. `configured` is the raw config value (`auto` / `cpu` / a
 * device id); `resolved` is what `resolveManagedDevice` returned
 * (`undefined` ⇒ no GPU picked → llama.cpp default / CPU fallback).
 */
function describeDeviceChoice(
  configured: string,
  resolved: string | undefined,
): string {
  if (configured === "cpu") return "cpu (forced)";
  if (configured === "auto") {
    return resolved ? `auto → ${resolved}` : "auto → CPU (no GPU detected)";
  }
  return resolved ?? configured;
}

/** Log-tail poll cadence while the LLM logs tab is active. */
/**
 * Deadline for the backend asset download on the auto-update path. The
 * zip is 27-39 MB, so this is generous for any working link; it exists
 * because a stalled-but-open TCP connection otherwise never resolves
 * and the update hangs for the life of the process. A timeout is
 * reported like any other update failure and retried on the next start.
 */
const BACKEND_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const LOGS_POLL_MS = 1000;

/** Snapshot refresh cadence while the Models tab is idle. */
const SNAPSHOT_POLL_MS = 5000;

/**
 * Faster refresh cadence while the user is actively waiting on the
 * daemon to come up. The normal 5s interval is too laggy for the
 * "⟳ starting…" indicator to feel responsive.
 */
const SNAPSHOT_POLL_MS_ACTIVE = 1000;

export interface LocalModelsOrchestratorHooks {
  /** Fired when the operator picks a managed chat model (before daemon I/O). */
  onManagedModelSelected?: (modelId: LocalModelId) => void;
  /** Fired after a successful chat daemon (re)start for the active model. */
  onManagedDaemonRestarted?: () => void;
}

export class LocalModelsOrchestrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private logsTimer: ReturnType<typeof setInterval> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  /** True while a daemon the TUI owns is running; used by `shutdown()`. */
  private daemonSupervised = false;
  /**
   * Chat and embedding pulls are independent channels: a new pull only
   * aborts another pull of the same kind.
   */
  private activeModelPullAbort: AbortController | null = null;
  private activeEmbeddingPullAbort: AbortController | null = null;
  /**
   * Single-flight guard for the backend download. Both `pullModel` and
   * `pullEmbeddingModel` `await this.pullBackend()` when the backend is
   * missing; without this a chat pull and an embedding pull started at the
   * same time would launch two concurrent `downloadBackend()` calls that
   * race on the same `<dataDir>/backend.next` staging dir — each clears it
   * before extracting, so the loser's tree is deleted mid-write and the
   * winner can swap in a partial install. Concurrent callers share the
   * same in-flight promise.
   */
  private backendPullInFlight: Promise<void> | null = null;
  /**
   * Devices enumerated via `llama-server --list-devices`, cached for the
   * process lifetime. `null` until a successful enumeration with the
   * backend present — the device table does not change at runtime, so we
   * avoid spawning the binary on every 5s snapshot refresh. macOS never
   * populates this (its GPU budget comes from unified RAM, no spawn).
   */
  private cachedDevices: GpuDevice[] | null = null;
  /**
   * Pre-download NVIDIA VRAM fallback (MiB), cached for the process
   * lifetime. `undefined` until the first probe; `null` once probed and
   * no NVIDIA GPU / `nvidia-smi` was found. Only consulted on
   * Linux/Windows when the backend is not yet on disk so the onboarding
   * model list can still flag oversized models without first downloading
   * llama.cpp. Once the backend lands, `cachedDevices` (Vulkan
   * enumeration, all vendors) takes over and this is ignored.
   */
  private cachedNvidiaVramMiB: number | null | undefined = undefined;

  /**
   * Live view of the non-embedding pull this orchestrator itself emits,
   * mirrored off the bus (one tap covers every emit site — GGUF, mmproj,
   * backend, HF custom). Lets the "not downloaded" errors embed the real
   * download progress instead of pretending nothing is happening.
   */
  private readonly chatPull = new ChatPullMirror();
  /**
   * The Hugging Face lookup currently in flight, if any. Cancelling
   * replaces the ref, so a response that lands afterwards finds itself
   * stale and dispatches nothing — the identity comparison is what
   * makes Escape trustworthy; the abort merely frees the socket.
   * Mirrors `use-onboarding-huggingface.ts`, which does the same for
   * the first-run flow.
   */
  private hfLookup: AbortController | null = null;

  constructor(
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly hooks?: LocalModelsOrchestratorHooks,
  ) {
    this.chatPull.attach(bus);
  }

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

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = null;
    this.stopLogsAutoRefresh();
    // Best-effort tear down the daemon we started. Anything the user
    // launched via `atomic-agent models start` in another terminal has
    // its own pid file and is not our responsibility.
    //
    // Awaited (not fire-and-forget): the daemon is spawned `detached`, so
    // it has its own process group and never receives the terminal SIGINT
    // on Ctrl+C — the only thing that stops it is this explicit kill. If we
    // do not wait for it, the host process exits before the kill lands and
    // llama-server is orphaned in the background.
    if (this.daemonSupervised) {
      this.daemonSupervised = false;
      const cfg = getConfig();
      // `stopOnExit: false` keeps the model warm between sessions (the
      // operator owns teardown via `models stop`). With it on, only the
      // LAST live session stops the daemon — a second TUI window still
      // chatting must not lose its model because this one closed first.
      if (
        cfg.localModels.managed.stopOnExit &&
        !hasOtherLiveSessions(cfg.paths.localModelsDataDir)
      ) {
        await this.stopDaemonSilent();
      }
    }
  }

  async refresh(): Promise<void> {
    this.bus.emit({ type: "local_models_refresh_started" });
    try {
      const cfg = getConfig();
      const dataDir = cfg.paths.localModelsDataDir;
      // The full model list — curated catalog plus the operator's own
      // Hugging Face additions — so a model added on first run has a
      // panel row to be marked active, re-pulled or deleted from.
      const rows = listLocalModels().map((def) => ({
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
      const embeddingActiveId: EmbeddingModelId | null =
        cfg.localModels.embeddings.modelId &&
        isKnownEmbeddingModelId(cfg.localModels.embeddings.modelId)
          ? cfg.localModels.embeddings.modelId
          : null;
      const embeddingRows: readonly EmbeddingModelRow[] =
        EMBEDDING_MODELS_CATALOG.map((def) => ({
          id: def.id,
          def,
          downloaded: isEmbeddingModelDownloaded(dataDir, def),
          active: def.id === embeddingActiveId,
        }));
      const embeddingDaemon: EmbeddingDaemonInfo =
        await this.collectEmbeddingDaemonInfo(dataDir, embeddingActiveId);
      this.reconcileHybridRecallFromDaemon(embeddingDaemon);
      const gpuBudgetGb = await this.resolveGpuBudget(cfg, dataDir);
      this.bus.emit({
        type: "local_models_snapshot_loaded",
        rows,
        backend: {
          currentTag: ver?.tag ?? null,
          latestTag,
          updateAvailable,
          autoUpdate: cfg.localModels.managed.autoUpdate,
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
        gpuBudgetGb,
        dataDir,
        embeddingRows,
        embeddingDaemon,
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

    if (this.activeModelPullAbort) {
      this.activeModelPullAbort.abort();
    }
    const controller = new AbortController();
    this.activeModelPullAbort = controller;

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

      this.activeModelPullAbort = null;
      this.bus.emit({ type: "local_models_pull_finished", kind: "chat" });

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

      // Memory-v2 phase 1B onboarding: if the operator has just
      // pulled their first chat model and there is no embedding on
      // disk yet, show a y/n prompt offering to download the default
      // embedding model in the same flow. The chat daemon still starts
      // immediately so the downloaded model is usable right away.
      if (this.shouldOfferEmbeddingOnboarding()) {
        const embDef = getEmbeddingModelDef(DEFAULT_EMBEDDING_MODEL_ID);
        this.bus.emit({
          type: "local_models_embedding_onboarding_opened",
          modelId: embDef.id,
          name: embDef.name,
          sizeLabel: embDef.sizeLabel,
        });
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: ${def.name} installed → offering embedding model for hybrid recall`,
        });
        await this.startChatDaemonAfterPull(def);
        return;
      }

      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ${def.name} installed → starting daemon…`,
      });
      if (await this.startChatDaemonAfterPull(def)) {
        this.bus.emit({ type: "ui_mode_set", mode: "chat" });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (this.activeModelPullAbort === controller) {
        this.activeModelPullAbort = null;
      }
      this.bus.emit({ type: "local_models_pull_failed", kind: "chat", error: msg });
    }
  }

  /**
   * Memory-v2 phase 1B onboarding. True when the operator has not yet
   * picked an embedding model AND none of the catalog rows are
   * downloaded. Catches the "fresh install" case after the first
   * chat-model pull. Does NOT fire when:
   *
   *  - vision/embeddings master switch left at v6 defaults but the
   *    operator already configured an embedding model explicitly,
   *  - any embedding GGUF already lives in the data dir (re-prompting
   *    on every chat pull would be noise),
   *  - the embedding catalog is empty (defensive guard for a future
   *    catalog-disable mode that does not exist yet).
   */
  private shouldOfferEmbeddingOnboarding(): boolean {
    const cfg = getConfig();
    if (cfg.localModels.embeddings.modelId !== null) return false;
    if (EMBEDDING_MODELS_CATALOG.length === 0) return false;
    const dataDir = cfg.paths.localModelsDataDir;
    return !EMBEDDING_MODELS_CATALOG.some((def) =>
      isEmbeddingModelDownloaded(dataDir, def),
    );
  }

  /**
   * Memory-v2 phase 1B onboarding. Resolution of the y/n prompt
   * surfaced after a successful chat-model pull. `accept=true`
   * downloads the default embedding model and then starts the paired
   * daemon; `accept=false` only starts the chat daemon (no embedding
   * row to wire). Either branch routes the operator back to chat on
   * success — the modal is a one-shot detour, not a sticky state.
   */
  async resolveEmbeddingOnboarding(accept: boolean): Promise<void> {
    this.bus.emit({ type: "local_models_embedding_onboarding_dismissed" });
    if (accept) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: pulling default embedding model (${DEFAULT_EMBEDDING_MODEL_ID})…`,
      });
      await this.pullEmbeddingModel(DEFAULT_EMBEDDING_MODEL_ID);
      return;
    } else {
      persistEmbeddingHybridRecall({ enabled: false });
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: embedding model skipped — hybrid recall stays off (can be enabled later from this panel)",
      });
    }
    if (await this.ensureChatDaemonRunningAfterOnboarding()) {
      this.bus.emit({ type: "ui_mode_set", mode: "chat" });
    }
  }

  private async ensureChatDaemonRunningAfterOnboarding(): Promise<boolean> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const chat = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (chat.running) return true;
    return this.startDaemon();
  }

  private async startChatDaemonAfterPull(def: LocalModelDef): Promise<boolean> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const running = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (running.running) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: restarting daemon with ${def.name}…`,
      });
      await this.stopProcessesForRestart({ silent: true });
    }
    return this.startDaemon();
  }

  private async startEmbeddingDaemonAfterPull(def: EmbeddingModelDef): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const chat = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (chat.running) {
      await this.startEmbeddingPairing();
      return;
    }
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: ${def.name} ready → starting chat+embedding daemons…`,
    });
    if (await this.startDaemon()) {
      this.bus.emit({ type: "ui_mode_set", mode: "chat" });
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
        kind: "chat",
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
          kind: "chat",
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
        kind: "chat",
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
          kind: "chat",
          percent,
          transferredBytes: transferred,
          totalBytes: total > 0 ? total : est,
        });
      },
    });
  }

/* ------------------------------------------------------------------ *
   * Add a model from Hugging Face — the Models pane's own branch of the
   * flow the first-run screen already had. Same resolver, same catalog
   * write, same pull; what is new is that it is reachable after
   * onboarding, when adding a second model is the actual task.
   * ------------------------------------------------------------------ */

  /**
   * Ask Hugging Face what GGUFs the reference names. Every failure — a
   * typo, a gated repo, a repo holding no GGUF at all — comes back as a
   * sentence and is shown on the editor that asked for the reference.
   */
  async resolveHuggingFaceReference(raw: string): Promise<void> {
    const controller = new AbortController();
    this.hfLookup?.abort();
    this.hfLookup = controller;
    this.bus.emit({ type: "local_models_hf_lookup_started" });
    try {
      const repo = await resolveHuggingFaceGgufChoices(raw, {
        signal: controller.signal,
      });
      if (this.hfLookup !== controller) return;
      this.hfLookup = null;
      this.bus.emit({ type: "local_models_hf_repo_resolved", repo });
    } catch (err) {
      if (this.hfLookup !== controller) return;
      this.hfLookup = null;
      this.bus.emit({
        type: "local_models_hf_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Escape while the lookup runs: drop the socket, keep what was typed. */
  cancelHuggingFaceLookup(): void {
    if (!this.hfLookup) return;
    this.hfLookup.abort();
    this.hfLookup = null;
    this.bus.emit({ type: "local_models_hf_lookup_cancelled" });
  }

  /**
   * Record the chosen file as a catalog entry, then hand it to the very
   * pull the curated rows use — which is what lands an added model on
   * the ordinary download screen rather than a second one built for it.
   */
  async addHuggingFaceChoice(
    repo: HuggingFaceRepoChoices,
    index: number,
  ): Promise<void> {
    const choice = repo.choices[index];
    if (!choice) return;
    let id: LocalModelId;
    try {
      const def = buildCustomModelDef({
        repoId: repo.repoId,
        revision: repo.revision,
        file: { path: choice.path, sizeBytes: choice.sizeBytes },
        mmproj: repo.mmproj,
      });
      // Written before the pull starts: `pullModel` resolves the id
      // through the catalog registry, and the registry is loaded from
      // the file this call writes.
      addCustomModel(def);
      id = def.id;
    } catch (err) {
      this.bus.emit({
        type: "local_models_hf_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.bus.emit({ type: "local_models_hf_closed" });
    await this.pullModel(id);
  }

  async pullBackend(): Promise<void> {
    // Coalesce concurrent callers onto one download. If a backend pull is
    // already running (e.g. a chat pull triggered it and an embedding pull
    // arrives while it is in flight), both await the same promise instead of
    // racing two `downloadBackend()` calls on the same directory.
    if (this.backendPullInFlight) {
      return this.backendPullInFlight;
    }
    const inFlight = this.runBackendPull().finally(() => {
      this.backendPullInFlight = null;
    });
    this.backendPullInFlight = inFlight;
    return inFlight;
  }

  private async runBackendPull(): Promise<void> {
    const dataDir = getConfig().paths.localModelsDataDir;
    this.bus.emit({
      type: "local_models_pull_started",
      pull: {
        kind: "backend",
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
            kind: "backend",
            percent,
            transferredBytes: transferred,
            totalBytes: total,
          });
        },
      });
      this.bus.emit({ type: "local_models_pull_finished", kind: "backend" });
      await this.refresh();
    } catch (e) {
      const msg =
        e instanceof GithubRateLimitedError
          ? `${e.message} Wait a few minutes and try again, or run with GITHUB_TOKEN=…`
          : e instanceof Error
            ? e.message
            : String(e);
      this.bus.emit({ type: "local_models_pull_failed", kind: "backend", error: msg });
    }
  }

  /**
   * Persist `localModels.mode: "managed"` on its own. `setActive` is
   * the usual writer of that mode, but the composer can switch the
   * route to "local" while nothing is downloaded yet — no model id to
   * set active — and without this the config would still say
   * `external`, so the backend control would mislabel the route
   * `custom` on the very next frame.
   */
  async useManagedMode(): Promise<void> {
    if (getConfig().localModels.mode === "managed") return;
    persistUserLocalModelsConfig({ mode: "managed" });
    resetConfigCache();
    await this.refresh();
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
    this.hooks?.onManagedModelSelected?.(id);
    await this.refresh();
    if (!isModelDownloaded(dataDir, getLocalModelDef(id))) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: model ${id} not downloaded — downloading now…`,
      });
      await this.pullModel(id);
      return;
    }
    const running = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (running.running) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: restarting daemon for ${id}…`,
      });
      await this.stopProcessesForRestart({ silent: true });
    }
    if (await this.startDaemon()) {
      // Tray refresh (optimistic id + `/props` re-read) is now fired by
      // `startDaemon` on success, so no explicit hook call is needed here.
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
      // A curated row survives its files' deletion — the catalog is the
      // product. A custom row exists only because the operator added it,
      // so deleting the model undoes the add too; otherwise the row
      // would linger with no other way to drop it from the list.
      if (def.family === "custom") removeCustomModel(id);
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
  /**
   * Cycle the managed daemon's GPU preference through
   * `auto → <each enumerated device> → cpu → auto`, persisting the
   * choice to `config.json`. Enumeration is best-effort: when the
   * backend is missing or reports no devices the cycle collapses to
   * `auto → cpu → auto`. Does not restart the daemon — the operator
   * presses `s` to apply.
   */
  /**
   * Flip `localModels.managed.autoUpdate`. The flag is on by default and
   * governs a background download, so it needs a way out that is not
   * "hand-edit config.json" — the CLI equivalent takes the whole file.
   * Takes effect on the next start; nothing in flight is cancelled.
   */
  async toggleBackendAutoUpdate(): Promise<void> {
    const next = !getConfig().localModels.managed.autoUpdate;
    persistUserLocalModelsConfig({ managed: { autoUpdate: next } });
    resetConfigCache();
    this.bus.emit({
      type: "runtime_info",
      line: next
        ? "local-llm: backend auto-update on — a newer llama.cpp is fetched after start"
        : "local-llm: backend auto-update off — update manually with 'B'",
    });
    await this.refresh();
  }

  async cycleManagedDevice(): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    let ids: string[] = [];
    if (isBackendDownloaded(dataDir)) {
      const { binaryName } = resolvePlatformAsset();
      const binPath = resolveServerBinPath(dataDir, binaryName);
      ids = (await listVulkanDevices(binPath)).map((d) => d.id);
    }
    const order = ["auto", ...ids, "cpu"];
    const current = cfg.localModels.managed.device;
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length];
    persistUserLocalModelsConfig({ managed: { device: next } });
    resetConfigCache();
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: device → ${next} (press 's' to restart and apply)`,
    });
    await this.refresh();
  }

  /**
   * Resolve the GPU memory budget (decimal GB) the active model would
   * have to fit into, or `null` when there is no meaningful budget (CPU
   * forced, no GPU, unsupported platform). On macOS the budget comes
   * from unified RAM without spawning anything; on Linux/Windows it
   * reads the chosen device's VRAM from a cached `--list-devices`
   * enumeration so the 5s refresh never re-spawns the binary.
   */
  private async resolveGpuBudget(
    cfg: ReturnType<typeof getConfig>,
    dataDir: string,
  ): Promise<number | null> {
    const platform = process.platform;
    const configuredDevice = cfg.localModels.managed.device;
    // macOS budget comes from unified RAM — no enumeration, no fallback.
    if (platform === "darwin") {
      return resolveGpuBudgetGb({
        platform,
        totalRamBytes: totalmem(),
        devices: [],
        configuredDevice,
      });
    }
    // No discrete GPU offload when forced to CPU; skip enumeration.
    if (configuredDevice === "cpu") return null;
    // Preferred source: Vulkan devices reported by the backend
    // (covers NVIDIA / AMD / Intel). Requires the binary on disk.
    if (this.cachedDevices === null && isBackendDownloaded(dataDir)) {
      const { binaryName } = resolvePlatformAsset();
      const binPath = resolveServerBinPath(dataDir, binaryName);
      this.cachedDevices = await listVulkanDevices(binPath);
    }
    const budget = resolveGpuBudgetGb({
      platform,
      totalRamBytes: totalmem(),
      devices: this.cachedDevices ?? [],
      configuredDevice,
    });
    if (budget !== null) return budget;
    // Fallback before the backend exists (onboarding): probe NVIDIA
    // VRAM directly via nvidia-smi so the model list can flag oversized
    // models without first downloading llama.cpp. NVIDIA-only; other
    // vendors stay null until the backend lands. Routed through the same
    // `resolveGpuBudgetGb` (as a synthetic discrete device, `auto` pick)
    // so the MiB -> decimal-GB conversion matches the backend path.
    if (this.cachedNvidiaVramMiB === undefined) {
      this.cachedNvidiaVramMiB = await probeNvidiaVramMiB();
    }
    if (this.cachedNvidiaVramMiB === null) return null;
    return resolveGpuBudgetGb({
      platform,
      totalRamBytes: totalmem(),
      devices: [
        {
          id: "nvidia-smi",
          description: "NVIDIA (nvidia-smi)",
          totalMemMiB: this.cachedNvidiaVramMiB,
          freeMemMiB: this.cachedNvidiaVramMiB,
        },
      ],
      configuredDevice: "auto",
    });
  }

  /**
   * @param opts.backendAlreadyChecked set by callers that ran
   * `applyBackendAutoUpdate` themselves. Without it a TUI launch
   * checks GitHub twice per start — two hits against the ~60 req/h
   * anonymous budget, and two passes racing on the same
   * `backend.next` staging dir.
   */
  async startDaemon(opts?: {
    backendAlreadyChecked?: boolean;
  }): Promise<boolean> {
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
    let justPulledBackend = false;
    if (!isBackendDownloaded(dataDir)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: backend missing — downloading…",
      });
      await this.pullBackend();
      if (!isBackendDownloaded(dataDir)) return false;
      justPulledBackend = true;
    }
    if (!isModelDownloaded(dataDir, def)) {
      // With a pull already in flight the honest message is the live
      // progress, not a bare "cannot start" that reads like a dead end.
      const progress = downloadProgressFor(this.chatPull.current, def.id);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: model ${def.name} not downloaded — cannot start (${
          progress ?? "press Enter on it to download"
        })`,
      });
      return false;
    }
    if (!justPulledBackend && !opts?.backendAlreadyChecked) {
      const updated = await this.applyBackendAutoUpdate(dataDir);
      if (!updated) return false;
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
      // Memory-v2 phase 1B: piggy-back the embedding daemon on the
      // same "start" action via the atomic-pair orchestrator. The
      // embedding side fails non-fatally — its outcome is reported as
      // an info line so the operator sees what happened, while the
      // chat side stays the source of truth for `daemonPhase`.
      const embedding = this.buildEmbeddingStartOptions(cfg, dataDir);
      // Resolve the GPU preference once so chat + embedding land on the
      // same device and the operator sees which one was picked.
      const { binaryName } = resolvePlatformAsset();
      const binPath = resolveServerBinPath(dataDir, binaryName);
      const device = await resolveManagedDevice(
        binPath,
        cfg.localModels.managed.device,
      );
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: device ${describeDeviceChoice(cfg.localModels.managed.device, device)}`,
      });
      const gpuBudgetGb = await this.resolveGpuBudget(cfg, dataDir);
      if (classifyVramFit(def, gpuBudgetGb) === "insufficient") {
        const needGb = estimateModelVramNeedGb(def);
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: ${def.name} needs ~${needGb.toFixed(1)} GB but GPU budget ~${gpuBudgetGb!.toFixed(1)} GB — may fail to load / OOM`,
        });
      }
      const result = await startChatAndEmbeddingDaemons({
        chat: {
          dataDir,
          modelId: mid,
          port: cfg.localModels.managed.port,
          chatTemplateFile: tpl,
          mmprojFile,
          contextSize: cfg.localModels.managed.contextSize,
          ...(device ? { device } : {}),
        },
        embedding: embedding
          ? { ...embedding, ...(device ? { device } : {}) }
          : embedding,
      });
      this.daemonSupervised = true;
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: ready — pid ${result.chat.pid} on http://127.0.0.1:${cfg.localModels.managed.port}`,
      });
      if (def.supportsVision) {
        this.bus.emit({
          type: "runtime_info",
          line: mmprojFile
            ? `local-llm: vision enabled (${def.mmprojFilename})`
            : `local-llm: vision disabled — mmproj not downloaded for ${def.id}`,
        });
      }
      this.reportEmbeddingStartOutcome(result.embedding, embedding);
      // Refresh the tray / prompt model label for EVERY start path
      // (pull auto-start, `s`, autoStart, setActive). The health poller
      // caches the model name per URL (`modelFetchedForUrl`) and would
      // otherwise keep showing the previous model after an in-place
      // restart on the same URL. `onManagedModelSelected` updates the
      // tray optimistically with the catalog id; `onManagedDaemonRestarted`
      // re-reads `/props` so it aligns with what llama-server reports.
      this.hooks?.onManagedModelSelected?.(mid);
      this.hooks?.onManagedDaemonRestarted?.();
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

  /**
   * Stop chat + embedding processes without clearing the operator's
   * embedding master switch. Used when swapping the active chat model.
   */
  private async stopProcessesForRestart(opts?: {
    silent?: boolean;
  }): Promise<void> {
    const dataDir = getConfig().paths.localModelsDataDir;
    this.bus.emit({ type: "local_models_daemon_phase_set", phase: "stopping" });
    if (!opts?.silent) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: stopping daemon for model swap…",
      });
    }
    this.beginActiveRefresh();
    try {
      await stopChatAndEmbeddingDaemons(dataDir);
      this.daemonSupervised = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit({ type: "local_models_daemon_error_set", message: msg });
      this.bus.emit({ type: "runtime_info", line: `local-llm: stop failed — ${msg}` });
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
      // Stops both chat and embedding daemons. Either side may raise a
      // `ForeignDaemonError` (cross-user daemon we cannot signal);
      // `stopChatAndEmbeddingDaemons` still stops the other side and
      // re-throws the combined message, surfaced via the bus below.
      await stopChatAndEmbeddingDaemons(dataDir);
      this.daemonSupervised = false;
      persistMemoryEmbeddingsEnabled(false);
      if (!opts?.silent) {
        this.bus.emit({
          type: "runtime_info",
          line: "local-llm: daemons stopped — hybrid recall off (embedding switch unchanged)",
        });
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
   * Stop only the managed *chat* daemon, leaving the embedding daemon —
   * and therefore hybrid recall — running. Used when the chat route moves
   * to an external llama-server: the managed chat process is the one that
   * got replaced, and it would otherwise sit on its VRAM forever.
   *
   * A no-op when nothing is running, so callers can fire it
   * unconditionally without emitting a misleading "stopped" line.
   * `daemonSupervised` is deliberately left alone: the embedding side may
   * still be ours to tear down at exit.
   */
  async stopChatDaemonOnly(): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const status = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (!status.running) {
      await this.refresh();
      return;
    }
    this.bus.emit({ type: "local_models_daemon_phase_set", phase: "stopping" });
    this.beginActiveRefresh();
    try {
      await stopChatDaemonProcess(dataDir);
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: managed chat daemon stopped — the external URL is the chat route now",
      });
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
   * is already unmounting), just the underlying process kill. Memory-v2
   * phase 1B: stops both daemons atomically.
   */
  private async stopDaemonSilent(): Promise<void> {
    try {
      await stopChatAndEmbeddingDaemons(getConfig().paths.localModelsDataDir, {
        timeoutMs: 2000,
      });
    } catch {
      /* best-effort during shutdown */
    }
  }

  /**
   * Resolve the optional `embedding` argument for `startChatAndEmbeddingDaemons`.
   * Returns `undefined` when embeddings are disabled, no model is selected, an
   * unknown model id is configured, or the model file isn't on disk — every
   * one of these is a "skip embedding" condition by design (graceful
   * degradation, see AGENTS.md §Memory-v2 phase 1B).
   */
  private buildEmbeddingStartOptions(
    cfg: ReturnType<typeof getConfig>,
    dataDir: string,
  ): EmbeddingDaemonStartOptions | undefined {
    const emb = cfg.localModels.embeddings;
    if (!emb.enabled) return undefined;
    if (!emb.modelId || !isKnownEmbeddingModelId(emb.modelId)) return undefined;
    const def = getEmbeddingModelDef(emb.modelId);
    if (!isEmbeddingModelDownloaded(dataDir, def)) return undefined;
    return { dataDir, modelId: emb.modelId, port: emb.port };
  }

  /**
   * Surface the embedding-side outcome to the runtime feed without
   * promoting it to a `daemon_error_set` — the chat daemon already
   * succeeded, so the panel-level error slot stays clear. Memory-v2
   * phase 1B: embedding failure ⇒ FTS5-only fallback, not a fatal stop.
   */
  private reportEmbeddingStartOutcome(
    embedding:
      | { pid: number }
      | { error: string }
      | { skipped: true },
    requested: EmbeddingDaemonStartOptions | undefined,
  ): void {
    if ("pid" in embedding) {
      const id = requested?.modelId ?? "embedding";
      persistMemoryEmbeddingsEnabled(true);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding daemon up (${id}, pid ${embedding.pid}) — hybrid recall on`,
      });
    } else if ("error" in embedding) {
      persistMemoryEmbeddingsEnabled(false);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding daemon failed — hybrid recall disabled (${embedding.error})`,
      });
    } else if (!requested) {
      // skipped is also returned when no embedding was requested;
      // only emit a hint when the operator has enabled embeddings but
      // the runtime found a reason to skip (e.g. model not downloaded).
      const emb = getConfig().localModels.embeddings;
      if (emb.enabled && emb.modelId) {
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: embedding skipped — model ${emb.modelId} not on disk`,
        });
      }
    }
  }

  /**
   * Memory-v2 phase 1B pairing invariant: if the chat daemon is alive,
   * the embedding daemon should be alive **iff** `embeddings.enabled`
   * + `modelId` is a known catalog entry + the GGUF is on disk.
   *
   * This helper reconciles the embedding side to that invariant
   * without touching the chat daemon. It is called from every code
   * path that mutates embedding-side config outside the main
   * `startDaemon` / `stopDaemon` flows (pull / activate / toggle /
   * adopt). When the chat daemon is not running we no-op — the next
   * `startDaemon` call will pair both sides atomically via
   * `startChatAndEmbeddingDaemons`, which is the cheaper path.
   *
   * @param opts.hotSwap when true, restart the embedding daemon even
   *   if it is already running. Used by `setActiveEmbedding` /
   *   `pullEmbeddingModel` where the model id (and possibly dim) has
   *   just changed and the running server is now stale.
   */
  private async ensureEmbeddingPaired(opts?: {
    hotSwap?: boolean;
  }): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;

    const chat = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (!chat.running) return;

    const desired = this.buildEmbeddingStartOptions(cfg, dataDir);
    const embStatus = await getEmbeddingDaemonStatus(
      dataDir,
      cfg.localModels.embeddings.port,
    );

    if (!desired) {
      if (embStatus.running) {
        const reason = !cfg.localModels.embeddings.enabled
          ? "disabled"
          : !cfg.localModels.embeddings.modelId
            ? "no model selected"
            : "model not on disk";
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: stopping embedding daemon (${reason})`,
        });
        try {
          await stopEmbeddingDaemon(dataDir, { timeoutMs: 4000 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.bus.emit({
            type: "runtime_info",
            line: `local-llm: embedding stop failed — ${msg}`,
          });
        }
      }
      if (cfg.memory.embeddings.enabled) {
        persistMemoryEmbeddingsEnabled(false);
      }
      return;
    }

    if (embStatus.running && !opts?.hotSwap) return;

    if (embStatus.running && opts?.hotSwap) {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: hot-swapping embedding daemon → ${desired.modelId}…`,
      });
      try {
        await stopEmbeddingDaemon(dataDir, { timeoutMs: 4000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: embedding stop failed — ${msg}`,
        });
        return;
      }
    } else {
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: starting embedding daemon (${desired.modelId})…`,
      });
    }

    try {
      const { pid } = await startEmbeddingDaemon(desired);
      persistMemoryEmbeddingsEnabled(true);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding daemon up (${desired.modelId}, pid ${pid}) — hybrid recall on`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      persistMemoryEmbeddingsEnabled(false);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding daemon failed — hybrid recall disabled (${msg})`,
      });
    }
  }

  /**
   * Keep `memory.embeddings.enabled` aligned with the live embedding
   * daemon: on when the operator enabled embeddings, a model is on
   * disk, and the daemon is running; off otherwise. Does not flip
   * `localModels.embeddings.enabled` — that is the operator master
   * switch (`E` hotkey).
   */
  private reconcileHybridRecallFromDaemon(emb: EmbeddingDaemonInfo): void {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const modelId = cfg.localModels.embeddings.modelId;
    const hasModel =
      modelId !== null &&
      isKnownEmbeddingModelId(modelId) &&
      isEmbeddingModelDownloaded(dataDir, getEmbeddingModelDef(modelId));
    const shouldEnable =
      cfg.localModels.embeddings.enabled && hasModel && emb.running;
    if (cfg.memory.embeddings.enabled === shouldEnable) return;
    persistMemoryEmbeddingsEnabled(shouldEnable);
  }

  /**
   * Memory-v2 phase 1B. Pull an embedding model GGUF. On success,
   * marks the model as active (`localModels.embeddings.modelId`) and
   * flips `localModels.embeddings.enabled = true` so the operator's
   * intent ("I want this for hybrid recall") is captured in one
   * keystroke. If the chat daemon is already running, the embedding
   * daemon is auto-paired (started or hot-swapped) so the operator
   * does not need a manual restart — pairing is the invariant.
   */
  async pullEmbeddingModel(id: EmbeddingModelId): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const def = getEmbeddingModelDef(id);

    if (!isBackendDownloaded(dataDir)) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: backend missing — downloading llama.cpp first…",
      });
      await this.pullBackend();
      if (!isBackendDownloaded(dataDir)) return;
    }

    if (this.activeEmbeddingPullAbort) {
      this.activeEmbeddingPullAbort.abort();
    }
    const controller = new AbortController();
    this.activeEmbeddingPullAbort = controller;

    const est = Math.round(def.fileSizeGb * (1024 * 1024 * 1024));
    this.bus.emit({
      type: "local_models_pull_started",
      pull: {
        kind: "embedding",
        modelId: def.id,
        label: `${def.name} (embedding)`,
        percent: 0,
        transferredBytes: 0,
        totalBytes: est,
        error: null,
      },
    });
    try {
      await downloadEmbeddingModel(dataDir, def, {
        signal: controller.signal,
        onProgress: (percent, transferred, total) => {
          this.bus.emit({
            type: "local_models_pull_progress",
            kind: "embedding",
            percent,
            transferredBytes: transferred,
            totalBytes: total > 0 ? total : est,
          });
        },
      });
      this.activeEmbeddingPullAbort = null;
      this.bus.emit({ type: "local_models_pull_finished", kind: "embedding" });
      persistEmbeddingHybridRecall({ enabled: true, modelId: id });
      await this.refresh();
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding model ${def.name} ready`,
      });
      await this.startEmbeddingDaemonAfterPull(def);
    } catch (e) {
      if (isAbortError(e)) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (this.activeEmbeddingPullAbort === controller) {
        this.activeEmbeddingPullAbort = null;
      }
      this.bus.emit({
        type: "local_models_pull_failed",
        kind: "embedding",
        error: msg,
      });
    }
  }

  /**
   * Memory-v2 phase 1B. Persist the operator's embedding-model choice
   * and refresh. If the chat daemon is running, hot-swap the embedding
   * daemon to the newly selected model so the pairing invariant holds
   * (see `ensureEmbeddingPaired`). When the new model is not yet on
   * disk, only the config is persisted — the next pull will pair on
   * success.
   */
  async setActiveEmbedding(id: EmbeddingModelId): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const def = getEmbeddingModelDef(id);
    if (!isEmbeddingModelDownloaded(dataDir, def)) {
      persistEmbeddingHybridRecall({ enabled: false, modelId: id });
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding ${def.name} selected (Enter to pull)`,
      });
      await this.refresh();
      return;
    }
    persistEmbeddingHybridRecall({ enabled: true, modelId: id });
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: embedding ${def.name} selected`,
    });
    await this.refresh();
    await this.startEmbeddingPairing();
  }

  /**
   * Memory-v2 phase 1B. Toggle `localModels.embeddings.enabled` — the
   * master switch. The pairing invariant is honoured: enabling spins
   * the embedding daemon up (when chat is alive + model is on disk),
   * disabling stops it. Chat daemon is never touched.
   */
  /**
   * Start (or hot-swap) the embedding daemon for the configured
   * active model. No-op when chat is down — the operator must press
   * `s` first so pairing can run.
   */
  async startEmbeddingPairing(): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    if (!cfg.localModels.embeddings.modelId) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: pick an embedding model first (j/k + Enter on a row)",
      });
      return;
    }
    if (!cfg.localModels.embeddings.enabled) {
      persistUserLocalModelsConfig({
        embeddings: {
          enabled: true,
          modelId: cfg.localModels.embeddings.modelId,
        },
      });
      resetConfigCache();
    }
    const chat = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (!chat.running) {
      this.bus.emit({
        type: "runtime_info",
        line: "local-llm: chat daemon is down — press s to start chat+embedding together",
      });
      return;
    }
    await this.ensureEmbeddingPaired({ hotSwap: true });
    await this.refresh();
  }

  async toggleEmbeddingEnabled(): Promise<void> {
    const cfg = getConfig();
    const next = !cfg.localModels.embeddings.enabled;
    if (next) {
      // Master switch on — hybrid recall flips on once the daemon is
      // actually running (`reconcileHybridRecallFromDaemon`).
      persistUserLocalModelsConfig({
        embeddings: {
          enabled: true,
          modelId: cfg.localModels.embeddings.modelId,
        },
      });
    } else {
      persistEmbeddingHybridRecall({ enabled: false });
    }
    resetConfigCache();
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: embeddings ${next ? "enabled" : "disabled"}`,
    });
    await this.refresh();
    if (next) {
      await this.startEmbeddingPairing();
    } else {
      await this.ensureEmbeddingPaired();
      await this.refresh();
    }
  }

  async disableEmbedding(): Promise<void> {
    const cfg = getConfig();
    const wasEnabled = cfg.localModels.embeddings.enabled;
    const dataDir = cfg.paths.localModelsDataDir;
    const status = await getEmbeddingDaemonStatus(
      dataDir,
      cfg.localModels.embeddings.port,
    );
    if (!wasEnabled && !status.running) return;
    persistEmbeddingHybridRecall({ enabled: false });
    resetConfigCache();
    this.bus.emit({
      type: "runtime_info",
      line: "local-llm: local embeddings disabled for cloud embedding route",
    });
    await this.ensureEmbeddingPaired();
    await this.refresh();
  }

  /**
   * Memory-v2 phase 1B. Delete an embedding model's GGUF from disk.
   * If the deleted model is the one currently configured as active,
   * the embedding daemon is stopped first so we never race against
   * a partially-deleted file the server still has mmap'd.
   */
  async removeEmbeddingModel(id: EmbeddingModelId): Promise<void> {
    const cfg = getConfig();
    const dataDir = cfg.paths.localModelsDataDir;
    const def = getEmbeddingModelDef(id);
    this.bus.emit({
      type: "runtime_info",
      line: `local-llm: removing embedding ${def.name}…`,
    });
    if (
      cfg.localModels.embeddings.modelId === id &&
      cfg.localModels.embeddings.enabled
    ) {
      const st = await getEmbeddingDaemonStatus(
        dataDir,
        cfg.localModels.embeddings.port,
      );
      if (st.running) {
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: stopping embedding daemon (was serving ${def.name})…`,
        });
        // Atomic stop is cheaper than calling stopEmbeddingDaemon
        // alone and keeps invariants consistent — but here we only
        // want the embedding side down. The atomic stop also stops
        // chat, which is a usability problem mid-conversation. Use
        // the embedding-only stop path instead.
        try {
          await stopEmbeddingDaemon(dataDir, { timeoutMs: 4000 });
        } catch {
          /* best-effort; removal proceeds either way */
        }
      }
    }
    try {
      await removeEmbeddingModelFiles(dataDir, id);
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: embedding ${def.name} removed`,
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
   * Build an `EmbeddingDaemonInfo` snapshot for the panel. Reads live
   * pid/health from `getEmbeddingDaemonStatus` so the indicator stays
   * accurate even when the daemon was started outside the TUI (e.g.
   * `atomic-agent models start` in another terminal).
   */
  private async collectEmbeddingDaemonInfo(
    dataDir: string,
    activeId: EmbeddingModelId | null,
  ): Promise<EmbeddingDaemonInfo> {
    const cfg = getConfig();
    const st = await getEmbeddingDaemonStatus(
      dataDir,
      cfg.localModels.embeddings.port,
    );
    return {
      enabled: cfg.localModels.embeddings.enabled,
      running: st.running,
      healthy: st.healthy,
      loading: st.loading,
      pid: st.pid,
      port: st.port,
      activeModelId: activeId,
    };
  }

  /**
   * Check GitHub Releases and replace the llama.cpp zip when a newer
   * tag exists. Returns whether the caller may proceed to start.
   *
   * Every update failure is fire-safe: the installer stages the new
   * build and only swaps it in once it is complete, so a failed check,
   * stop or download leaves the previous binary on disk and start
   * continues on it. `false` is reserved for the one case that cannot
   * be papered over — the daemon was stopped for an update and no
   * usable backend remains.
   */
  private async applyBackendAutoUpdate(
    dataDir: string,
    opts?: { keepDaemonRunning?: boolean },
  ): Promise<boolean> {
    try {
      const result = await maybeAutoUpdateBackend(dataDir, {
        enabled: getConfig().localModels.managed.autoUpdate,
        keepDaemonRunning: opts?.keepDaemonRunning,
        // The zip is small (27-39 MB) but the link may not be. Without a
        // deadline a stalled-open connection pins the download for the
        // life of the process; the next start retries from scratch.
        signal: AbortSignal.timeout(BACKEND_DOWNLOAD_TIMEOUT_MS),
        onWillDownload: () => {
          this.bus.emit({
            type: "local_models_pull_started",
            pull: {
              kind: "backend",
              modelId: "_backend",
              label: "llama.cpp backend",
              percent: 0,
              transferredBytes: 0,
              totalBytes: 0,
              error: null,
            },
          });
        },
        onProgress: (percent: number, transferred: number, total: number) => {
          this.bus.emit({
            type: "local_models_pull_progress",
            kind: "backend",
            percent,
            transferredBytes: transferred,
            totalBytes: total,
          });
        },
      });
      if (result.action === "updated") {
        this.bus.emit({ type: "local_models_pull_finished", kind: "backend" });
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: updated llama.cpp ${result.from ?? "none"} → ${result.to}`,
        });
      } else if (result.action === "check_failed") {
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: backend update check failed — starting current binary (${result.error})`,
        });
      } else if (result.action === "deferred") {
        this.bus.emit({
          type: "runtime_info",
          line:
            result.reason === "daemon_live"
              ? "local-llm: backend update deferred — will install on next start"
              : "local-llm: backend update deferred — another session is using the current binary",
        });
      } else if (result.action === "update_failed") {
        this.bus.emit({
          type: "local_models_pull_failed",
          kind: "backend",
          error: result.error,
        });
        if (!result.backendUsable) {
          this.bus.emit({
            type: "runtime_info",
            line: `local-llm: backend update failed and no usable backend remains — ${result.error}`,
          });
          return false;
        }
        this.bus.emit({
          type: "runtime_info",
          line: `local-llm: backend update failed — starting current binary (${result.error})`,
        });
      }
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit({
        type: "local_models_pull_failed",
        kind: "backend",
        error: msg,
      });
      this.bus.emit({
        type: "runtime_info",
        line: `local-llm: backend auto-update failed — ${msg}`,
      });
      return false;
    }
  }

  /**
   * Called once at TUI startup. If the user is in managed mode AND the
   * backend + model are already on disk AND no daemon is currently
   * running, start the daemon so the user lands in a ready state
   * without needing an extra keypress.
   *
   * The backend auto-update runs **after** the daemon is up, never
   * before. Checking first meant the user got a rendered TUI they
   * could type into while no model was loaded — a prompt that silently
   * does nothing reads as a broken agent, and the download (27-39 MB,
   * unbounded on a stalled link) sat on that path. Starting first
   * costs one session on the previous binary; the swap is picked up on
   * the next start. A daemon already serving a model is left alone for
   * the same reason.
   */
  async autoStartIfReady(): Promise<void> {
    const cfg = getConfig();
    if (cfg.llm?.activeTextProvider && cfg.llm.activeTextProvider !== "local-llama") {
      return;
    }
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
      // The chat daemon may have been started before the embedding
      // model was downloaded / configured. Reconcile the embedding
      // side to the current intent so the pairing invariant holds
      // (see `ensureEmbeddingPaired`).
      await this.ensureEmbeddingPaired();
      await this.refresh();
      this.scheduleBackendAutoUpdate(dataDir);
      return;
    }
    // `startDaemon` owns the pre-start check on the path where the
    // backend has to be replaced before a daemon exists; here it must
    // not run one, because the deferred pass below owns it.
    await this.startDaemon({ backendAlreadyChecked: true });
    this.scheduleBackendAutoUpdate(dataDir);
  }

  /**
   * Run the backend auto-update once the daemon is serving, off the
   * start path. Deliberately not awaited: the result only matters for
   * the *next* start, so nothing the user is waiting on depends on it.
   * `maybeAutoUpdateBackend` already defers when any daemon is live
   * (`hasOtherLiveSessions` / `readRunningPid`), so the model we just
   * started is not pulled out from under the user mid-turn.
   */
  private scheduleBackendAutoUpdate(dataDir: string): void {
    void this.applyBackendAutoUpdate(dataDir, {
      keepDaemonRunning: true,
    }).catch(() => {
      /* applyBackendAutoUpdate already reports failures on the bus */
    });
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
    const dataDir = cfg.paths.localModelsDataDir;
    const path = resolveLogFilePath(dataDir);
    try {
      const chat = readLogTail(path);
      // Memory-v2 phase 1B. Stitch the embedding log tail onto the same
      // viewport when it exists. Keeps a single "LLM Logs" tab — two
      // tabs would split operator attention while the embedding daemon
      // is the rare-but-load-bearing piece they actually want to debug.
      const embedTail = this.readEmbeddingLogTailSilent(dataDir);
      const text = embedTail
        ? `${chat.text}\n\n── llama-embed.log ──\n${embedTail.text}`
        : chat.text;
      this.bus.emit({
        type: "local_llm_logs_loaded",
        text,
        path,
        size: chat.size + (embedTail?.size ?? 0),
        truncated: chat.truncated || (embedTail?.truncated ?? false),
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

  /**
   * Best-effort tail of `llama-embed.log`. Returns `null` when the
   * file does not exist yet (embedding daemon has never been started
   * in this `dataDir`) so the chat-only path stays unaffected.
   */
  private readEmbeddingLogTailSilent(
    dataDir: string,
  ): { text: string; size: number; truncated: boolean } | null {
    const path = resolveEmbeddingLogFilePath(dataDir);
    try {
      return readLogTail(path);
    } catch {
      return null;
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
