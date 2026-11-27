/**
 * Linear channel (ATO-2324): mention the agent in a Linear issue comment
 * (or assign it the issue) and it answers as a comment in the same
 * thread. Signed workspace webhook in, GraphQL `commentCreate` out.
 * Setup in [README.md](README.md).
 */

import { resolve } from "node:path";

import type { ChannelDefinition } from "../channel.js";
import { DiscordLockfile as PidLockfile } from "../discord/discord-lockfile.js";
import { LinearChannel } from "./linear-channel.js";
import { readLinearMentions, readLinearOnAssign, readLinearPort } from "./linear-types.js";

export { LinearChannel } from "./linear-channel.js";
export type { LinearChannelDeps, LinearEndpoint } from "./linear-channel.js";
export { LinearApi, LinearApiError, fitCommentBody, linearAuthHeader } from "./linear-api.js";
export { LinearApprovalBridge, formatLinearPrompt } from "./linear-approval-bridge.js";
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
      handles: readLinearMentions(ctx.channelConfig.options),
      onAssign: readLinearOnAssign(ctx.channelConfig.options),
      sessionMapPath: resolve(ctx.stateDir, "linear-session.json"),
      lock: new PidLockfile(resolve(ctx.stateDir, "linear.lock")),
      onStatus: ctx.emitStatus,
    }),
};
