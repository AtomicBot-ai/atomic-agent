/**
 * Linear channel (ATO-2324): mention the agent in a Linear issue comment
 * (or assign it the issue) and it answers as a comment in the same
 * thread. Signed workspace webhook in (or polling, ATO-2464), GraphQL
 * `commentCreate` out.
 * Setup in [README.md](README.md).
 */

import { resolve } from "node:path";

import type { ChannelDefinition } from "../channel.js";
import { DiscordLockfile as PidLockfile } from "../discord/discord-lockfile.js";
import { LinearChannel } from "./linear-channel.js";
import { linearTokenRefresher } from "./linear-oauth.js";
import {
  readLinearMentions,
  readLinearMode,
  readLinearOnAssign,
  readLinearPollMs,
  readLinearPort,
} from "./linear-types.js";

export { LinearChannel } from "./linear-channel.js";
export type { LinearChannelDeps, LinearEndpoint } from "./linear-channel.js";
export { LinearApi, LinearApiError, fitCommentBody, linearAuthHeader } from "./linear-api.js";
export { LinearApprovalBridge, formatLinearPrompt } from "./linear-approval-bridge.js";
export {
  downloadLinearUpload,
  findLinearUploads,
  isLinearUploadUrl,
  receiveLinearUploads,
  LINEAR_ATTACHMENT_LIMIT_BYTES,
  LINEAR_ATTACHMENTS_PER_COMMENT,
} from "./linear-attachments.js";
export { LINEAR_HELP_TEXT, parseLinearCommand, runLinearCommand } from "./linear-commands.js";
export type { LinearCommand } from "./linear-commands.js";
export { LinearTurnQueue, LINEAR_QUEUE_LIMIT } from "./linear-turn-queue.js";
export { LinearApprovalBindings } from "./linear-approval-bindings.js";
export { agentSessionJob, stripLeadingMention, LINEAR_AGENT_NOT_OWNER } from "./linear-agent-session.js";
export type { LinearJob } from "./linear-inbound-handler.js";
export { createLinearEndpoint, LINEAR_DEFAULT_POLL_MS } from "./linear-endpoint.js";
export { LinearPoller, LINEAR_KEY_REFUSED } from "./linear-poller.js";
export type { LinearPollerDeps } from "./linear-poller.js";
export { commentEvent, pollAssignments, pollComments, LINEAR_POLL_MAX_PAGES } from "./linear-poll-queries.js";
export type { PolledEvent } from "./linear-poll-queries.js";
export {
  buildLinearAuthorizeUrl,
  exchangeLinearCode,
  linearTokenRefresher,
  newOAuthState,
  refreshLinearToken,
  waitForLinearOAuthCode,
  LINEAR_APP_SCOPES,
  LINEAR_OAUTH_CLIENT_SECRET_KEY,
  LINEAR_OAUTH_REDIRECT_URI,
  LINEAR_OAUTH_REFRESH_TOKEN_KEY,
} from "./linear-oauth.js";
export type { LinearTokens } from "./linear-oauth.js";
export {
  disableLinearChannel,
  findLinearUserByEmail,
  saveLinearSecret,
  writeLinearChannelConfig,
  LINEAR_USER_ID_RE,
} from "./linear-setup.js";
export type { LinearChannelSettings } from "./linear-setup.js";
export { handleLinearEvent, acquireOrCreateSession } from "./linear-inbound-handler.js";
export type { LinearInboundContext } from "./linear-inbound-handler.js";
export { mentionsAgent, stripAgentMention } from "./linear-mention.js";
export { LinearOwnComments } from "./linear-own-comments.js";
export { LinearServer, handleLinearRequest, LINEAR_MAX_BODY_BYTES } from "./linear-server.js";
export { verifyLinearSignature, checkLinearTimestamp, LINEAR_TIMESTAMP_TOLERANCE_MS } from "./linear-signature.js";
export * from "./linear-types.js";

export const LINEAR_CHANNEL: ChannelDefinition = {
  id: "linear",
  label: "Linear",
  create: (ctx) =>
    new LinearChannel({
      runtime: ctx.runtime,
      logger: ctx.logger,
      approvals: ctx.approvals,
      approvalRouter: ctx.approvalRouter,
      enabled: ctx.channelConfig.enabled,
      ownerIds: ctx.channelConfig.ownerIds,
      port: readLinearPort(ctx.channelConfig.options),
      mode: readLinearMode(ctx.channelConfig.options),
      pollMs: readLinearPollMs(ctx.channelConfig.options),
      pollCursorPath: resolve(ctx.stateDir, "linear-poll-cursor.json"),
      handles: readLinearMentions(ctx.channelConfig.options),
      onAssign: readLinearOnAssign(ctx.channelConfig.options),
      sessionMapPath: resolve(ctx.stateDir, "linear-session.json"),
      inboxDir: resolve(ctx.stateDir, "inbox", "linear"),
      refreshToken: linearTokenRefresher(
        ctx.stateDir,
        typeof ctx.channelConfig.options.oauthClientId === "string" ? ctx.channelConfig.options.oauthClientId : undefined,
      ),
      lock: new PidLockfile(resolve(ctx.stateDir, "linear.lock")),
      onStatus: ctx.emitStatus,
    }),
};
