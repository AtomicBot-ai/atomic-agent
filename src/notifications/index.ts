/**
 * Out-of-band pings — a background download telling the operator it
 * landed. One REST call on credentials the Integrations hub stores; no
 * channel loop involved.
 */
export {
  formatDownloadNotification,
  isDownloadNotifyChannelReady,
  notifyDownloadOutcome,
  type DownloadNotifyInput,
  type DownloadNotifyResult,
} from "./download-notifier.js";
