/**
 * Discord remote-control channel. See AGENTS.md §"Discord channel".
 */

export { DiscordChannel } from "./discord-channel.js";
export type { DiscordChannelDeps } from "./discord-channel.js";
export { DiscordApi, DiscordApiError } from "./discord-api.js";
export type { DiscordUser, DiscordComponentRow } from "./discord-api.js";
export { DiscordGateway } from "./discord-gateway.js";
export type { GatewayDeps, GatewayLogger } from "./discord-gateway.js";
export {
  backoffMs,
  MAX_BACKOFF_MS,
} from "./discord-gateway-transport.js";
export type { WebSocketLike } from "./discord-gateway-transport.js";
export {
  DISCORD_API_BASE,
  DISCORD_BOT_TOKEN_KEY,
  DISCORD_INTENTS,
  DISCORD_MESSAGE_LIMIT,
  chunkMessage,
  describeCloseCode,
  resolveDiscordToken,
  scrubDiscordError,
} from "./discord-channel-types.js";
export { DiscordLockfile } from "./discord-lockfile.js";
export { DiscordSessionPointer } from "./discord-session-pointer.js";
export type { DiscordSessionPointerData } from "./discord-session-pointer.js";
export {
  handleDiscordMessage,
  stripMention,
} from "./discord-inbound-handler.js";
export type {
  DiscordMessageEvent,
  DiscordInboundContext,
} from "./discord-inbound-handler.js";
export {
  DiscordApprovalBridge,
  buttonsFor,
  formatPrompt,
} from "./discord-approval-bridge.js";
export type { DiscordInteractionEvent } from "./discord-approval-bridge.js";
export {
  writeDiscordSettings,
  writeDiscordToken,
} from "./discord-settings.js";
export type {
  DiscordSettingsPaths,
  DiscordSettingsPatch,
} from "./discord-settings.js";
