/**
 * Slack channel (ATO-499): DMs and @mentions over Socket Mode, replies
 * in the thread, approvals as Block Kit buttons. See ../docs/adapters.md.
 */

import { resolve } from "node:path";

import type { ChannelDefinition } from "../channel.js";
import { DiscordLockfile as PidLockfile } from "../discord/discord-lockfile.js";
import { SlackChannel } from "./slack-channel.js";

export { SlackChannel } from "./slack-channel.js";
export type { SlackChannelDeps } from "./slack-channel.js";
export { SlackApi, SlackApiError, retryAfterMs } from "./slack-api.js";
export { SlackSocket } from "./slack-socket.js";
export type { SlackSocketDeps } from "./slack-socket.js";
export { SlackApprovalBridge, approvalBlocks, ACTION_ID_PREFIX } from "./slack-approval-bridge.js";
export { handleSlackEvent, refOf, stripMention } from "./slack-inbound-handler.js";
export type { SlackInboundContext, SlackRef } from "./slack-inbound-handler.js";
export { escapeSlackText, markdownToSlack } from "./slack-format.js";
export {
  SLACK_APP_TOKEN_KEY,
  SLACK_BOT_TOKEN_KEY,
  SLACK_MESSAGE_LIMIT,
  resolveSlackToken,
  scrubSlackError,
} from "./slack-types.js";
export type { SlackEnvelope, SlackMessageEvent, SlackTarget } from "./slack-types.js";

/** `options.threadReplies`: anything but an explicit `false` keeps threading on. */
export function readThreadReplies(options: Record<string, string | number | boolean>): boolean {
  const raw = options.threadReplies;
  return !(raw === false || raw === "false" || raw === 0);
}

export const slackChannelDefinition: ChannelDefinition = {
  id: "slack",
  label: "Slack",
  create: (ctx) =>
    new SlackChannel({
      runtime: ctx.runtime,
      logger: ctx.logger,
      approvals: ctx.approvals,
      approvalRouter: ctx.approvalRouter,
      enabled: ctx.channelConfig.enabled,
      ownerIds: ctx.channelConfig.ownerIds,
      threadReplies: readThreadReplies(ctx.channelConfig.options),
      sessionMapPath: resolve(ctx.stateDir, "slack-session.json"),
      lock: new PidLockfile(resolve(ctx.stateDir, "slack.lock")),
      onStatus: ctx.emitStatus,
    }),
};
