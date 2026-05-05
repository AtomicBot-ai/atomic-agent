export { TelegramChannel, scrubErrorMessage } from "./telegram-channel.js";
export type {
  BotFactory,
  BotInstance,
  ChannelLock,
  PairingStateSnapshot,
  TelegramChannelDeps,
} from "./telegram-channel.js";
export type {
  InboundContext,
  InboundTextUpdate,
} from "./inbound-handler.js";
export { ApprovalBridge } from "./approval-bridge.js";
export type {
  ApprovalBridgeDeps,
  InboundCallbackUpdate,
} from "./approval-bridge.js";
export type { TelegramApi } from "./outbound-sender.js";
export {
  TelegramSessionPointer,
  type TelegramSessionPointerData,
} from "./telegram-session-pointer.js";
export {
  DefaultPairingMode,
  DEFAULT_PAIRING_TIMEOUT_MS,
} from "./pairing-mode.js";
export type {
  ClaimedPairing,
  PairingMode,
  PairingModeOptions,
} from "./pairing-mode.js";
export {
  TELEGRAM_BOT_TOKEN_KEY,
  readTelegramSettings,
  writeTelegramSettings,
  writeTelegramToken,
} from "./telegram-settings.js";
export type { PersistedTelegramSettings } from "./telegram-settings.js";
