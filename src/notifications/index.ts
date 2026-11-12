/**
 * Out-of-band pings — a background download telling the operator it
 * landed, a finished turn or task, an approval waiting. One REST call on
 * credentials the Integrations hub stores (or, for phone push, an ntfy
 * topic in config); no channel loop involved.
 */
export {
  formatDownloadNotification,
  isDownloadNotifyChannelReady,
  notifyDownloadOutcome,
  type DownloadNotifyInput,
  type DownloadNotifyResult,
} from "./download-notifier.js";
export {
  PUSH_BODY_MAX,
  PUSH_TIMEOUT_MS,
  cleanPushText,
  generatePushTopic,
  isPushReady,
  pushSubscribeUrl,
  sendPush,
  type PushMessage,
  type PushSendInput,
  type PushSendResult,
} from "./ntfy-client.js";
export {
  formatApprovalPush,
  formatDownloadPush,
  formatTaskPush,
  formatTurnPush,
  type PushTurnOutcome,
} from "./push-messages.js";
export {
  disablePushNotifications,
  enablePushNotifications,
  pushPrivacyNote,
  type PushSetupOptions,
  type PushSetupResult,
} from "./push-setup.js";
export { createPushTaskReportSink } from "./push-task-report.js";
