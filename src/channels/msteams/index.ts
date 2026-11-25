/**
 * Microsoft Teams channel (ATO-506): personal chats and @mentions over
 * the user's own Azure Bot registration, Bot Framework REST spoken
 * directly, approvals as Adaptive Cards. See ../docs/adapters.md and
 * ../docs/msteams.md.
 */

import { resolve } from "node:path";

import type { ChannelDefinition } from "../channel.js";
import { DiscordLockfile as PidLockfile } from "../discord/discord-lockfile.js";
import { TeamsChannel } from "./msteams-channel.js";
import { readTeamsPort, readTeamsTenantId } from "./msteams-types.js";

export { TeamsChannel } from "./msteams-channel.js";
export type { TeamsChannelDeps, TeamsEndpoint } from "./msteams-channel.js";
export { TeamsApi, TeamsApiError, BOT_FRAMEWORK_SCOPE, retryAfterMs } from "./msteams-api.js";
export { TeamsJwtVerifier, TeamsAuthError, BOT_FRAMEWORK_ISSUER, BOT_FRAMEWORK_OPENID_URL, normalizeServiceUrl } from "./msteams-jwt.js";
export type { BotFrameworkJwk } from "./msteams-jwt.js";
export { TeamsServer, handleTeamsRequest, MAX_BODY_BYTES } from "./msteams-server.js";
export type { TeamsRequest, TeamsResponse, TeamsServerDeps } from "./msteams-server.js";
export { TeamsApprovalBridge, approvalCard, conversationRoot } from "./msteams-approval-bridge.js";
export { handleTeamsActivity, mentionsBot, refOf, stripBotMention } from "./msteams-inbound-handler.js";
export type { TeamsInboundContext, TeamsRef } from "./msteams-inbound-handler.js";
export {
  MSTEAMS_APP_ID_KEY,
  MSTEAMS_APP_PASSWORD_KEY,
  MSTEAMS_DEFAULT_PORT,
  MSTEAMS_MESSAGES_PATH,
  MSTEAMS_MESSAGE_LIMIT,
  readTeamsPort,
  readTeamsTenantId,
  resolveTeamsSecret,
  scrubTeamsError,
} from "./msteams-types.js";
export type { TeamsAccount, TeamsActivity, TeamsTarget } from "./msteams-types.js";

export const msteamsChannelDefinition: ChannelDefinition = {
  id: "msteams",
  label: "Microsoft Teams",
  create: (ctx) =>
    new TeamsChannel({
      runtime: ctx.runtime,
      logger: ctx.logger,
      approvals: ctx.approvals,
      approvalRouter: ctx.approvalRouter,
      enabled: ctx.channelConfig.enabled,
      ownerIds: ctx.channelConfig.ownerIds,
      port: readTeamsPort(ctx.channelConfig.options),
      tenantId: readTeamsTenantId(ctx.channelConfig.options),
      sessionMapPath: resolve(ctx.stateDir, "msteams-session.json"),
      lock: new PidLockfile(resolve(ctx.stateDir, "msteams.lock")),
      onStatus: ctx.emitStatus,
    }),
};
