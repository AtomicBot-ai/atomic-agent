/**
 * Google Chat remote-control channel (ATO-506). See ../docs/adapters.md.
 * The operator's own Chat app, events pulled from their own Pub/Sub
 * subscription: no relay, no public URL.
 */

import type { ChannelDefinition } from "../channel.js";
import { GoogleChatChannel } from "./googlechat-channel.js";

export const GOOGLE_CHAT_CHANNEL: ChannelDefinition = {
  id: "googlechat",
  label: "Google Chat",
  create: (ctx) =>
    new GoogleChatChannel({
      runtime: ctx.runtime,
      logger: ctx.logger,
      approvals: ctx.approvals,
      approvalRouter: ctx.approvalRouter,
      channelConfig: ctx.channelConfig,
      stateDir: ctx.stateDir,
      emitStatus: ctx.emitStatus,
    }),
};

export { GoogleChatChannel } from "./googlechat-channel.js";
export type { GoogleChatChannelDeps } from "./googlechat-channel.js";
export { GoogleChatApi, GoogleChatApiError, retryAfterMs } from "./googlechat-api.js";
export type { PubsubReceivedMessage } from "./googlechat-api.js";
export {
  GoogleAuthError,
  GoogleTokenSource,
  parseServiceAccountKey,
  signServiceAccountJwt,
} from "./googlechat-auth.js";
export type { ServiceAccountKey } from "./googlechat-auth.js";
export { GoogleChatApprovalBridge, formatGoogleChatPrompt } from "./googlechat-approval-bridge.js";
export { GOOGLE_CHAT_HELP_TEXT, handleGoogleChatCommand } from "./googlechat-commands.js";
export {
  chunkGoogleChatText,
  decodeGoogleChatEvent,
  googleChatRequestText,
  googleChatSenderLine,
} from "./googlechat-events.js";
export type { GoogleChatEvent, GoogleChatUser } from "./googlechat-events.js";
export { handleGoogleChatEvent } from "./googlechat-inbound-handler.js";
export type { GoogleChatInboundContext } from "./googlechat-inbound-handler.js";
export { GoogleChatPullLoop } from "./googlechat-pull-loop.js";
export {
  GOOGLE_CHAT_CREDENTIALS_KEY,
  GOOGLE_CHAT_MESSAGE_LIMIT,
  GOOGLE_CHAT_SCOPES,
  isGoogleChatOwner,
  readGoogleChatOptions,
  resolveCredentialsPath,
  scrubGoogleChatError,
} from "./googlechat-types.js";
export type { GoogleChatOptions, GoogleChatUserRef } from "./googlechat-types.js";
