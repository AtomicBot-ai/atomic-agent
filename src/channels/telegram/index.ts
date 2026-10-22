export { TelegramChannel, scrubErrorMessage } from "./telegram-channel.js";
export { OwnerAlreadyPairedError } from "./telegram-channel.js";
export type {
  BotFactory,
  BotInstance,
  ChannelLock,
  OpenedPairingWindow,
  PairingOutcome,
  PairingStateSnapshot,
  StartPairingOptions,
  TaskReportDelivery,
  TelegramChannelDeps,
} from "./telegram-channel.js";
export {
  formatTaskReportMessage,
  TASK_REPORT_ERROR_MAX_CHARS,
  TASK_REPORT_PROMPT_PREVIEW_CHARS,
  TASK_REPORT_RESULT_MAX_CHARS,
  TASK_REPORT_TRUNCATION_MARKER,
} from "./task-report-message.js";
export type {
  InboundContext,
  InboundTextUpdate,
  TelegramBotIdentity,
  TelegramTarget,
} from "./inbound-handler.js";
export { addressedText, stripBotMention, threadOf } from "./inbound-handler.js";
export { ApprovalBridge } from "./approval-bridge.js";
export type {
  ApprovalBridgeDeps,
  InboundCallbackUpdate,
} from "./approval-bridge.js";
export type { TelegramApi } from "./outbound-sender.js";
export {
  TelegramSessionPointer,
  telegramChatKey,
  type TelegramChatSessionEntry,
  type TelegramSessionPointerData,
} from "./telegram-session-pointer.js";
export {
  DefaultPairingMode,
  DEFAULT_PAIRING_TIMEOUT_MS,
  PAIRING_CODE_DIGITS,
  generatePairingCode,
  pairingCodeIn,
} from "./pairing-mode.js";
export type {
  ClaimedPairing,
  PairingClaimResult,
  PairingMode,
  PairingModeOptions,
} from "./pairing-mode.js";
export {
  pairingInstruction,
  pairedOwnerLine,
  replaceOwnerPrompt,
} from "./pairing-copy.js";
export {
  TELEGRAM_BOT_TOKEN_KEY,
  readTelegramSettings,
  writeTelegramSettings,
  writeTelegramToken,
} from "./telegram-settings.js";
export type { PersistedTelegramSettings } from "./telegram-settings.js";
export {
  fetchTelegramApi,
  sendTelegramOneShot,
  type OneShotTelegramInput,
} from "./one-shot-sender.js";
