/**
 * iMessage channel (ATO-630, macOS only). See ../docs/adapters.md.
 */

import type { ChannelDefinition } from "../channel.js";
import { ImessageChannel } from "./imessage-channel.js";

export const imessageChannelDefinition: ChannelDefinition = {
  id: "imessage",
  label: "iMessage",
  platforms: ["darwin"],
  create: (ctx) =>
    new ImessageChannel({
      runtime: ctx.runtime,
      logger: ctx.logger,
      approvals: ctx.approvals,
      approvalRouter: ctx.approvalRouter,
      enabled: ctx.channelConfig.enabled,
      ownerIds: ctx.channelConfig.ownerIds,
      options: ctx.channelConfig.options,
      stateDir: ctx.stateDir,
      onStatus: ctx.emitStatus,
    }),
};

export { ImessageChannel } from "./imessage-channel.js";
export type { ImessageChannelDeps, ImessageLock } from "./imessage-channel.js";
export { ImessageApprovalBridge, formatApprovalPrompt } from "./imessage-approval-bridge.js";
export { handleImessageMessage, replyTarget, IMESSAGE_HELP_TEXT } from "./imessage-inbound-handler.js";
export type { ImessageInboundContext } from "./imessage-inbound-handler.js";
export { isOwnerHandle, maskHandle, normalizeHandle, normalizeOwnerIds } from "./imessage-handle.js";
export { parseImessageOptions, IMESSAGE_DEFAULT_BINARY } from "./imessage-options.js";
export type { ImessageOptions } from "./imessage-options.js";
export { LineSplitter, parseImsgLine } from "./imsg-event.js";
export type { ImsgMessage } from "./imsg-event.js";
export {
  IMSG_AUTOMATION_HINT,
  IMSG_DISK_ACCESS_HINT,
  IMSG_INSTALL_HINT,
  classifyImsgFailure,
  scrubImessageError,
} from "./imsg-errors.js";
export type { ImsgFailure, ImsgFailureKind } from "./imsg-errors.js";
export { chunkText, createImsgSender, IMESSAGE_CHUNK_CHARS, ImsgSendError, sendArgs } from "./imsg-send.js";
export type { ExecFileLike, ImessageTarget, ImsgSender } from "./imsg-send.js";
export { CHAT_DB_PATH, ChatDbServiceLookup, ServiceCheck } from "./imessage-service-check.js";
export type { MessageServiceLookup } from "./imessage-service-check.js";
export { ImsgWatcher } from "./imsg-watch.js";
export type { ImsgWatcherDeps, SpawnLike, WatchChild } from "./imsg-watch.js";
