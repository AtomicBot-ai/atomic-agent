/**
 * Telegram as an Integrations-hub tenant.
 *
 * The hub is the *whole* setup surface for the channel: token, owner,
 * kill switch, pairing and restart. The channel used to own a Manage
 * tab of its own; keeping both meant two places to configure one thing
 * and an operator having to know which. See AGENTS.md §"Integrations
 * hub".
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
 * the shape `scrubErrorMessage` already keys off. Checking it at entry
 * turns a truncated paste from a silent "channel won't start" into an
 * immediate, specific complaint.
 */
const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export const telegramIntegration: IntegrationDescriptor = {
  id: "telegram",
  label: "Telegram",
  summary: "Drive the agent from Telegram — DM your bot and it acts on it",
  docsUrl: "https://core.telegram.org/bots#botfather",
  appliesLive: true,
  fields: [
    {
      key: TOKEN_FIELD,
      label: "Bot token",
      envVar: TELEGRAM_BOT_TOKEN_KEY,
      secret: true,
      required: true,
      help: "From @BotFather. Then press p to pair your account.",
      validate: (raw) =>
        TOKEN_SHAPE.test(raw)
          ? undefined
          : "Doesn't look like a bot token — expected digits, a colon, then a long string, as @BotFather issues it.",
    },
    {
      key: "ownerUserId",
      label: "Owner",
      // Public numeric id, not a secret -- and small enough to be safe
      // as a number, unlike a Discord snowflake.
      store: "config",
      configPath: "telegram.ownerUserId",
      secret: false,
      required: true,
      help: "Press p to pair — the next account to DM the bot becomes the owner.",
      validate: (raw) =>
        /^\d{1,15}$/.test(raw)
          ? undefined
          : "A Telegram user id is numeric. Press p to pair instead of typing it.",
    },
    {
      key: "enabled",
      label: "Channel",
      kind: "boolean",
      store: "config",
      configPath: "telegram.enabled",
      secret: false,
      required: false,
      help: "on starts the channel; off stops it without forgetting the token.",
    },
  ],
  actions: [
    {
      key: "p",
      id: "pair",
      label: "pair",
      // Pairing opens a window that claims the next DM. Without a token
      // there is no bot to DM, so the window could only ever time out.
      available: (ctx) => ctx.presentFields.has(TOKEN_FIELD),
    },
    {
      key: "s",
      id: "restart",
      label: "restart",
      available: (ctx) => ctx.presentFields.has(TOKEN_FIELD),
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!ctx.presentFields.has(TOKEN_FIELD)) {
      return { level: "not_configured", detail: "no bot token" };
    }
    if (!isConfigured(telegramIntegration, ctx.presentFields)) {
      return { level: "configured", detail: "token saved — press p to pair" };
    }
    switch (ctx.channelStates?.get("telegram")) {
      case "up":
        return { level: "connected", detail: "channel up" };
      case "down":
        return {
          level: "error",
          detail:
            ctx.channelErrors?.get("telegram") ?? "channel failed to start",
        };
      case "starting":
        return { level: "configured", detail: "starting" };
      default:
        // Paired but switched off -- a normal resting state, so say how
        // to start it rather than badging it red.
        return { level: "configured", detail: "paired — set Channel to on" };
    }
  },
};
