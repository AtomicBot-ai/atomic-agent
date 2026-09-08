/**
 * Discord as an Integrations-hub tenant.
 *
 * Like Telegram, the hub owns only the credential: pairing the owner
 * account and switching the channel on happen against a running
 * channel, not in a credential list.
 */

import { DISCORD_BOT_TOKEN_KEY } from "../channels/discord/index.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";

const TOKEN_FIELD = "botToken";

/**
 * A Discord bot token is three base64url segments separated by dots.
 * Checking the shape at entry catches the single most common mistake —
 * pasting the application **client secret** or the public key from the
 * same portal page, neither of which has this shape and both of which
 * would otherwise fail as an opaque 401 at connect.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/;

export const discordIntegration: IntegrationDescriptor = {
  id: "discord",
  label: "Discord",
  summary: "Drive the agent from Discord — DM the bot or @mention it in a channel",
  docsUrl: "https://discord.com/developers/applications",
  appliesLive: false,
  fields: [
    {
      key: TOKEN_FIELD,
      label: "Bot token",
      envVar: DISCORD_BOT_TOKEN_KEY,
      secret: true,
      required: true,
      help: "Bot → Reset Token in the Developer Portal, then invite the bot to a server (or just DM it).",
      validate: (raw) =>
        TOKEN_SHAPE.test(raw)
          ? undefined
          : "Doesn't look like a bot token — that's the shape of the client secret or public key. Use Bot → Reset Token.",
    },
    {
      key: "ownerUserId",
      label: "Owner user ID",
      // Config-backed, not a secret: a Discord user id is public.
      store: "config",
      configPath: "discord.ownerUserId",
      secret: false,
      required: true,
      help: "Your Discord user ID (Settings → Advanced → Developer Mode, then right-click yourself → Copy User ID). Only this account can drive the agent.",
      validate: (raw) =>
        /^\d{15,25}$/.test(raw)
          ? undefined
          : "A Discord user ID is 15-25 digits. Enable Developer Mode, then right-click your name → Copy User ID.",
    },
    {
      key: "enabled",
      label: "Channel",
      kind: "boolean",
      store: "config",
      configPath: "discord.enabled",
      secret: false,
      required: false,
      help: "on connects the gateway; off disconnects without forgetting the token.",
    },
  ],
  actions: [
    {
      key: "s",
      id: "restart",
      label: "restart",
      available: (ctx) => ctx.presentFields.has("botToken"),
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!isConfigured(discordIntegration, ctx.presentFields)) {
      return { level: "not_configured", detail: "no bot token" };
    }
    switch (ctx.channelStates?.get("discord")) {
      case "up":
        return { level: "connected", detail: "gateway connected" };
      case "down":
        return {
          level: "error",
          // The channel's own reason, not a generic line pointing at a
          // tab that does not exist.
          detail: ctx.channelErrors?.get("discord") ?? "gateway failed",
        };
      case "starting":
        return { level: "configured", detail: "connecting" };
      default:
        // Everything is configured but the channel is switched off.
        // Say exactly how to turn it on rather than pointing at a tab
        // that does not exist.
        // Paired but switched off -- a normal resting state.
        return { level: "configured", detail: "ready — set Channel to on" };
    }
  },
};
