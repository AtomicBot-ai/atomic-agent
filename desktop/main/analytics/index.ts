/**
 * Desktop analytics (SPEC "Desktop analytics — shared contract (v1)").
 * main.ts reaches everything through this barrel as `A.*`, one line per hook.
 */

export {
  afterAnalyticsWrite,
  analyticsEnabled,
  beforeAnalyticsWrite,
  currentRunMode,
  flushAnalytics,
  globalProps,
  initAnalytics,
  installId,
  isTestRun,
  onAnalyticsEnabledChange,
  refreshRunMode,
  sendingAllowed,
  track,
  trackFromRenderer,
} from "./core.js";
export { agentAnalyticsEnv, desktopVersion, installChannelFor } from "./environment.js";
export {
  agentRestarting,
  agentStartFailed,
  agentStatus,
  appClosing,
  appOpened,
  beginSession,
  launchBackendSettled,
  noteOrphanReaped,
  turnEnded,
  windowCrashed,
  windowShown,
} from "./lifecycle.js";
export { ChatTurnTracker, type TurnSummary } from "./chat-turns.js";
export {
  configureDownloads,
  downloadCancelRequested,
  downloadFinished,
  downloadProgress,
  downloadRefusedBusy,
  downloadStarted,
  hfLookupDone,
  runtimeUpdated,
} from "./downloads.js";
export {
  configureSetup,
  localBackendStarted,
  maybeModelConfigured,
  providerKeyChecked,
  switchBegin,
  switchEnd,
} from "./setup.js";
export {
  agentImportDone,
  debugReportSaved,
  skillAction,
  skillInstalled,
  taskAction,
  taskCreated,
  telegramConfigWrite,
  telegramStep,
  tuiImportDone,
  voiceEnded,
  voiceFrame,
  voiceInstalled,
  voiceProbed,
  voiceStarted,
  workspaceChosen,
} from "./features.js";
