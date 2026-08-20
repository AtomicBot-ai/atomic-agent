export {
  LOCAL_MODELS_CATALOG,
  DEFAULT_LLAMACPP_MODEL_ID,
  getLocalModelDef,
  isKnownLocalModelId,
  EMBEDDING_MODELS_CATALOG,
  DEFAULT_EMBEDDING_MODEL_ID,
  getEmbeddingModelDef,
  isKnownEmbeddingModelId,
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

export { resolveDownloadAsset } from "./windows-backend-variant.js";

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

export { downloadFile, type DownloadProgressFn } from "./download-file.js";
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
