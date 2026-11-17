/**
 * WhatsApp channel through WhatsApp Web pairing (ATO-502), on the
 * unofficial protocol via `baileys`. Off by default. See ../docs/adapters.md.
 */

import type { ChannelDefinition } from "../channel.js";
import { WhatsAppChannel } from "./whatsapp-channel.js";
import { WHATSAPP_CHANNEL_ID } from "./whatsapp-types.js";

export const WHATSAPP_CHANNEL: ChannelDefinition = {
  id: WHATSAPP_CHANNEL_ID,
  label: "WhatsApp",
  create: (ctx) => new WhatsAppChannel(ctx),
};

export { WhatsAppChannel } from "./whatsapp-channel.js";
export type { WhatsAppChannelSeams } from "./whatsapp-channel.js";
export { WhatsAppApprovalBridge, formatWhatsAppPrompt } from "./whatsapp-approval-bridge.js";
export { formatWhatsAppSenderLine, handleWhatsAppMessage } from "./whatsapp-inbound-handler.js";
export type { WhatsAppInboundContext } from "./whatsapp-inbound-handler.js";
export type {
  LoadWhatsAppConnector,
  WhatsAppConnector,
  WhatsAppSocket,
  WhatsAppSocketEvents,
} from "./whatsapp-transport.js";
export {
  WHATSAPP_CHANNEL_ID,
  WHATSAPP_MESSAGE_LIMIT,
  WHATSAPP_MODULE_MISSING,
  WHATSAPP_PAIR_AGAIN,
  WHATSAPP_UNOFFICIAL_WARNING,
  chatKeyOf,
  classifyClose,
  isBroadcastJid,
  isGroupJid,
  normalizeWhatsAppId,
  parseWhatsAppMessage,
  readWhatsAppOptions,
  scrubWhatsAppError,
} from "./whatsapp-types.js";
export type { RawWhatsAppMessage, WhatsAppInbound, WhatsAppOptions } from "./whatsapp-types.js";
