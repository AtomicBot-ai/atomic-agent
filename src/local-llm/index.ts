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
} from "./catalog/models-catalog.js";

export {
  isWindowsArm64,
  resolvePlatformAsset,
  UnsupportedPlatformError,
  WINDOWS_ARM64_NO_BACKEND_MESSAGE,
  type PlatformAsset,
} from "./backend/platform-assets.js";

export {
  resolveDownloadAsset,
  BACKEND_VARIANT_PREFERENCES,
  getConfiguredBackendVariant,
  isBackendVariantPreference,
  isWindowsGpuBackendAsset,
  setConfiguredBackendVariant,
  type BackendVariantPreference,
} from "./backend/windows-backend-variant.js";
export {
  fallBackToCpuBackend,
  shouldFallBackToCpuBackend,
} from "./backend/cpu-backend-fallback.js";

export {
  resolveBackendDir,
  resolveModelsDir,
  resolveServerBinPath,
  resolveModelDir,
  resolveModelFilePath,
  resolveMmprojFilePath,
  resolveVersionFilePath,
  resolveBackendCheckFilePath,
  resolvePidFilePath,
  resolveLogFilePath,
  resolveThroughputFilePath,
  resolveLaunchFilePath,
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
} from "./downloads/download-file.js";
export {
  DEFAULT_DOWNLOAD_CONNECTIONS,
  MAX_DOWNLOAD_CONNECTIONS,
  resolveDownloadConnections,
  setDefaultDownloadConnections,
} from "./downloads/download-settings.js";
export {
  DEFAULT_HF_ENDPOINT,
  huggingFaceEndpointHost,
  isHuggingFaceUrl,
  normalizeHuggingFaceEndpoint,
  resolveHuggingFaceEndpoint,
  rewriteHuggingFaceUrl,
  setDefaultHuggingFaceEndpoint,
} from "./catalog/huggingface-endpoint.js";
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
} from "./downloads/download-jobs.js";
export {
  STALE_RUNNING_MS,
  downloadJobSilenceMs,
  isDownloadJobStale,
} from "./downloads/download-job-staleness.js";
export {
  isDownloadNotifyChannel,
  readDownloadNotify,
  writeDownloadNotify,
  type DownloadNotifyChannel,
} from "./downloads/download-notify-file.js";
export {
  downloadWorkerArgs,
  looksLikeDownloadWorker,
  spawnDownloadWorker,
  stopDownloadWorker,
  type SpawnDownloadWorkerInput,
  type SpawnDownloadWorkerResult,
  type StopDownloadWorkerResult,
} from "./downloads/download-spawn.js";
export {
  DEFAULT_WORKER_LIFETIME_MS,
  WORKER_GIVE_UP_AFTER_MS,
  initialDownloadJob,
  runDownloadWorker,
  type DownloadWorkerInput,
  type DownloadWorkerOutcome,
} from "./downloads/download-worker.js";
export {
  readBackendVersion,
  writeBackendVersion,
  type BackendVersionInfo,
} from "./backend/backend-version.js";
export {
  fetchLatestRelease,
  resetLatestReleaseCache,
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
  GithubRateLimitedError,
  type LatestReleaseInfo,
} from "./backend/backend-installer.js";
export {
  AUTO_UPDATE_RECHECK_MS,
  AUTO_UPDATE_RETRY_MS,
  checkForBackendUpdateForPanel,
  forgetBackendCheck,
  maybeAutoUpdateBackend,
  type AutoUpdateBackendResult,
} from "./backend/ensure-latest-backend.js";
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
} from "./downloads/model-installer.js";
export { resolveChatTemplatePath } from "./chat-templates.js";
export {
  parseListDevices,
  pickBestDevice,
  listVulkanDevices,
  deviceTableOnce,
  resolveManagedDevice,
  sharesSystemMemory,
  type GpuDevice,
  type ListDevices,
} from "./backend/gpu-devices.js";
export {
  resolveGpuBudgetGb,
  MAC_UNIFIED_GPU_FRACTION,
  type ResolveGpuBudgetInput,
} from "./backend/gpu-memory-budget.js";
export { probeNvidiaVramMiB, parseNvidiaVramMiB } from "./backend/nvidia-smi-vram.js";
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
  probeThroughput,
  readThroughputRecord,
  readReusableThroughput,
  slotsAllIdle,
  throughputBasis,
  THROUGHPUT_REUSE_MAX_AGE_MS,
  writeThroughputRecord,
  readLaunchRecord,
  writeLaunchRecord,
  THROUGHPUT_PROBE_TOKENS,
  type DaemonStartOptions,
  type DaemonStartResult,
  type DaemonStatus,
  type EmbeddingDaemonStartOptions,
  type LaunchRecord,
  type StartBothResult,
  type ThroughputRecord,
  type ThroughputSample,
} from "./server/daemon-lifecycle.js";
export {
  classifyPrefixReuse,
  countSlidingWindowLayers,
  GgufFormatError,
  HYBRID_ARCHITECTURES,
  isHybridArchitecture,
  kvLayoutSourceFromMetadata,
  parseGgufHeader,
  readGgufMetadata,
  readGgufMetadataSync,
  readModelPrefixReuse,
  resetPrefixReuseCache,
  type GgufMetadata,
  type PrefixReuse,
  type PrefixReuseVerdict,
} from "./catalog/gguf-metadata.js";
export {
  isSwaFullPreference,
  resolveSwaFullDecision,
  SWA_FULL_MAX_RATIO,
  SWA_FULL_PREFERENCES,
  type SwaFullDecision,
  type SwaFullPreference,
} from "./server/swa-full.js";
export { readLogTail, type LogTailResult } from "./server/log-tail.js";
export { describeServerFault, type ServerFault } from "./server/server-fault.js";
export {
  assertPortFree,
  fetchServedModelIds,
  PortTakenError,
} from "./server/daemon-launch-guard.js";
export {
  describeReclaim,
  reclaimManagedPort,
  type ReclaimOutcome,
  type ReclaimRequest,
} from "./server/port-reclaim.js";

export {
  huggingFaceToken,
  listHuggingFaceGgufFiles,
  resolveHuggingFaceFileUrl,
  type HuggingFaceFile,
} from "./catalog/huggingface-api.js";
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
} from "./catalog/huggingface-fit.js";
export {
  buildCustomModelDef,
  buildCustomModelId,
  formatGgufSize,
  ggufSizeGb,
} from "./catalog/huggingface-model-def.js";
export {
  parseHuggingFaceModelRef,
  type HuggingFaceModelRef,
} from "./catalog/huggingface-ref.js";
export {
  resolveHuggingFaceGgufChoices,
  type HuggingFaceGgufChoice,
  type HuggingFaceRepoChoices,
} from "./catalog/huggingface-resolve.js";
