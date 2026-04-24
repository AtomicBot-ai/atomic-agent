export {
  LOCAL_MODELS_CATALOG,
  DEFAULT_LLAMACPP_MODEL_ID,
  getLocalModelDef,
  isKnownLocalModelId,
  type LocalModelId,
  type LocalModelDef,
} from "./models-catalog.js";

export {
  resolvePlatformAsset,
  UnsupportedPlatformError,
  type PlatformAsset,
} from "./platform-assets.js";

export {
  resolveBackendDir,
  resolveModelsDir,
  resolveServerBinPath,
  resolveModelDir,
  resolveModelFilePath,
  resolveVersionFilePath,
  resolvePidFilePath,
  resolveLogFilePath,
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
export { isModelDownloaded, downloadModel, removeModel } from "./model-installer.js";
export { resolveChatTemplatePath } from "./chat-templates.js";
export {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readRunningPid,
  probeLlamaHealth,
  type DaemonStartOptions,
  type DaemonStatus,
} from "./daemon-lifecycle.js";
export { readLogTail, type LogTailResult } from "./log-tail.js";
