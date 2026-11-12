/**
 * Signal channel through a user-run signal-cli daemon (ATO-629).
 * See ../docs/adapters.md.
 */

import type { ChannelDefinition } from "../channel.js";
import { SignalChannel } from "./signal-channel.js";
import { SIGNAL_CHANNEL_ID } from "./signal-types.js";

export const SIGNAL_CHANNEL: ChannelDefinition = {
  id: SIGNAL_CHANNEL_ID,
  label: "Signal",
  create: (ctx) => new SignalChannel(ctx),
};

export { SignalChannel } from "./signal-channel.js";
export type { SignalChannelSeams } from "./signal-channel.js";
export { SignalApprovalBridge, formatSignalPrompt } from "./signal-approval-bridge.js";
export { SignalEventStream, SseParser } from "./signal-events.js";
export type { SseEvent } from "./signal-events.js";
export { handleSignalEnvelope } from "./signal-inbound-handler.js";
export type { SignalInboundContext } from "./signal-inbound-handler.js";
export { SignalRpc, SignalRpcError } from "./signal-rpc.js";
export type { SignalTarget } from "./signal-rpc.js";
export { formatSignalSenderLine } from "./signal-sender-line.js";
export {
  SIGNAL_CHANNEL_ID,
  SIGNAL_DEFAULT_URL,
  SIGNAL_MESSAGE_LIMIT,
  chatKeyOf,
  extractEnvelope,
  normalizeSignalId,
  readSignalOptions,
  scrubSignalError,
  toInbound,
} from "./signal-types.js";
export type { SignalEnvelope, SignalInbound, SignalOptions } from "./signal-types.js";
