export { TelegramChannel, scrubErrorMessage } from "./telegram-channel.js";
export type {
  BotFactory,
  BotInstance,
  ChannelLock,
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
