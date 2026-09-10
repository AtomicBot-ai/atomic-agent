export {
  LOCAL_MODELS_CATALOG,
  DEFAULT_LLAMACPP_MODEL_ID,
  getLocalModelDef,
  isKnownLocalModelId,
  listLocalModels,
  setCustomLocalModels,
  EMBEDDING_MODELS_CATALOG,
  DEFAULT_EMBEDDING_MODEL_ID,
  getEmbeddingModelDef,
  isKnownEmbeddingModelId,
  type CuratedLocalModelId,
  type LocalModelId,
  type LocalModelDef,
  type EmbeddingModelId,
  type EmbeddingModelDef,
} from "./models-catalog.js";

export {
  resolvePlatformAsset,
  UnsupportedPlatformError,
  type PlatformAsset,
} from "./platform-assets.js";

export {
  resolveDownloadAsset,
  BACKEND_VARIANT_PREFERENCES,
  getConfiguredBackendVariant,
  isBackendVariantPreference,
  isWindowsGpuBackendAsset,
  setConfiguredBackendVariant,
  type BackendVariantPreference,
} from "./windows-backend-variant.js";
export {
  fallBackToCpuBackend,
  shouldFallBackToCpuBackend,
} from "./cpu-backend-fallback.js";

export {
  resolveBackendDir,
  resolveModelsDir,
  resolveServerBinPath,
  resolveModelDir,
  resolveModelFilePath,
  resolveMmprojFilePath,
  resolveVersionFilePath,
  resolvePidFilePath,
  resolveLogFilePath,
  resolveEmbeddingPidFilePath,
  resolveEmbeddingLogFilePath,
} from "./backend-paths.js";

export {
  DEFAULT_GIVE_UP_AFTER_MS,
  DownloadGaveUpError,
  classifyDownloadError,
  downloadFile,
  discardPartialDownload,
  isResumableDownloadError,
  isRetryableDownloadError,
  readPartialDownload,
  resolvePartialMetaPath,
  resolvePartialPath,
  type DownloadErrorKind,
  type DownloadFileOptions,
  type DownloadProgressFn,
  type DownloadRetryFn,
  type DownloadRetryInfo,
  type PartialDownloadMeta,
} from "./download-file.js";
export {
  DEFAULT_DOWNLOAD_CONNECTIONS,
  MAX_DOWNLOAD_CONNECTIONS,
  resolveDownloadConnections,
  setDefaultDownloadConnections,
} from "./download-settings.js";
export {
  DEFAULT_HF_ENDPOINT,
  huggingFaceEndpointHost,
  isHuggingFaceUrl,
  normalizeHuggingFaceEndpoint,
  resolveHuggingFaceEndpoint,
  rewriteHuggingFaceUrl,
  setDefaultHuggingFaceEndpoint,
} from "./huggingface-endpoint.js";
export {
  DOWNLOAD_JOB_VERSION,
  downloadJobId,
  isDownloadJobLive,
  listDownloadJobs,
  readDownloadJob,
  reconcileDownloadJob,
  removeDownloadJob,
  resolveDownloadJobPath,
  resolveDownloadLogPath,
  resolveDownloadNotifyPath,
  resolveDownloadsDir,
  writeDownloadJob,
  type DownloadJob,
  type DownloadJobKind,
  type DownloadJobMode,
  type DownloadJobStatus,
  type DownloadJobNotified,
  type DownloadJobWaiting,
} from "./download-jobs.js";
export {
  STALE_RUNNING_MS,
  downloadJobSilenceMs,
  isDownloadJobStale,
} from "./download-job-staleness.js";
export {
  isDownloadNotifyChannel,
  readDownloadNotify,
  writeDownloadNotify,
  type DownloadNotifyChannel,
} from "./download-notify-file.js";
export {
  downloadWorkerArgs,
  looksLikeDownloadWorker,
  spawnDownloadWorker,
  stopDownloadWorker,
  type SpawnDownloadWorkerInput,
  type SpawnDownloadWorkerResult,
  type StopDownloadWorkerResult,
} from "./download-spawn.js";
export {
  DEFAULT_WORKER_LIFETIME_MS,
  WORKER_GIVE_UP_AFTER_MS,
  initialDownloadJob,
  runDownloadWorker,
  type DownloadWorkerInput,
  type DownloadWorkerOutcome,
} from "./download-worker.js";
export {
  readBackendVersion,
  writeBackendVersion,
  type BackendVersionInfo,
} from "./backend-version.js";
export {
  fetchLatestRelease,
  resetLatestReleaseCache,
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
  GithubRateLimitedError,
  type LatestReleaseInfo,
} from "./backend-installer.js";
export {
  maybeAutoUpdateBackend,
  type AutoUpdateBackendResult,
} from "./ensure-latest-backend.js";
export {
  isModelDownloaded,
  isMmprojDownloaded,
  downloadModel,
  downloadMmproj,
  removeModel,
  isEmbeddingModelDownloaded,
  downloadEmbeddingModel,
  removeEmbeddingModel,
  type ModelDownloadOptions,
} from "./model-installer.js";
export { resolveChatTemplatePath } from "./chat-templates.js";
export {
  parseListDevices,
  pickBestDevice,
  listVulkanDevices,
  resolveManagedDevice,
  type GpuDevice,
} from "./gpu-devices.js";
export {
  resolveGpuBudgetGb,
  MAC_UNIFIED_GPU_FRACTION,
  type ResolveGpuBudgetInput,
} from "./gpu-memory-budget.js";
export { probeNvidiaVramMiB, parseNvidiaVramMiB } from "./nvidia-smi-vram.js";
export {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readRunningPid,
  classifyPidLiveness,
  DaemonHealthError,
  ForeignDaemonError,
  probeLlamaHealth,
  buildLlamaServerArgs,
  startEmbeddingDaemon,
  stopEmbeddingDaemon,
  getEmbeddingDaemonStatus,
  buildEmbeddingServerArgs,
  startChatAndEmbeddingDaemons,
  stopChatAndEmbeddingDaemons,
  type DaemonStartOptions,
  type DaemonStatus,
  type EmbeddingDaemonStartOptions,
  type StartBothResult,
} from "./daemon-lifecycle.js";
export { readLogTail, type LogTailResult } from "./log-tail.js";

export {
  huggingFaceToken,
  listHuggingFaceGgufFiles,
  resolveHuggingFaceFileUrl,
  type HuggingFaceFile,
} from "./huggingface-api.js";
export {
  describeRejectedGgufFiles,
  isFullPrecisionGguf,
  isMmprojFile,
  isMtpCompanionFile,
  isShardedGguf,
  judgeGgufFile,
  ramWarningFor,
  type GgufJudgement,
  type GgufVerdict,
} from "./huggingface-fit.js";
export {
  buildCustomModelDef,
  buildCustomModelId,
  formatGgufSize,
  ggufSizeGb,
} from "./huggingface-model-def.js";
export {
  parseHuggingFaceModelRef,
  type HuggingFaceModelRef,
} from "./huggingface-ref.js";
export {
  resolveHuggingFaceGgufChoices,
  type HuggingFaceGgufChoice,
  type HuggingFaceRepoChoices,
} from "./huggingface-resolve.js";
