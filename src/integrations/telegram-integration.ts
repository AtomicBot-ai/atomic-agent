/**
 * Telegram as an Integrations-hub tenant.
 *
 * Only the **credential** moves here. Pairing, the owner id, start/stop
 * and the live chat view stay on the Telegram tab: those are operations
 * on a running channel, not configuration, and folding a pairing
 * countdown into a credential list would make both worse. The hub owns
 * "what is my token", the tab owns "what is the bot doing".
 */

import { TELEGRAM_BOT_TOKEN_KEY } from "../channels/telegram/index.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";

const TOKEN_FIELD = "botToken";

/**
 * A Telegram bot token is `<6..12 digits>:<>=30 [A-Za-z0-9_-] chars>` —
 * the same shape `scrubErrorMessage` keys off. Checking it at entry
 * turns a silent "channel won't start" into an immediate, specific
 * complaint about the paste.
 */
const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export const telegramIntegration: IntegrationDescriptor = {
  id: "telegram",
  label: "Telegram",
  summary: "Drive the agent from Telegram — pair and start from the Telegram tab",
  docsUrl: "https://core.telegram.org/bots#botfather",
  appliesLive: false,
  fields: [
    {
      key: TOKEN_FIELD,
      label: "Bot token",
      envVar: TELEGRAM_BOT_TOKEN_KEY,
      secret: true,
      required: true,
      help: "From @BotFather. Pair the owner account on the Telegram tab.",
      validate: (raw) =>
        TOKEN_SHAPE.test(raw)
          ? undefined
          : "Doesn't look like a bot token — expected digits, a colon, then a long string, as @BotFather issues it.",
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!isConfigured(telegramIntegration, ctx.presentFields)) {
      return { level: "not_configured", detail: "no bot token" };
    }
    switch (ctx.channelStates?.get("telegram")) {
      case "up":
        return { level: "connected", detail: "channel up" };
      case "down":
        return {
          level: "error",
          detail: "channel failed to start — see the Telegram tab",
        };
      case "starting":
        return { level: "configured", detail: "channel starting" };
      default:
        // Token present but the channel is off or unpaired. That is a
        // normal resting state, not an error -- point at the tab that
        // can fix it rather than badging it red.
        return {
          level: "configured",
          detail: "token saved — pair and enable on the Telegram tab",
        };
    }
  },
};
