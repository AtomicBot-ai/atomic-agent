/**
 * Discord as an Integrations-hub tenant.
 *
 * Like Telegram, the hub owns only the credential: pairing the owner
 * account and switching the channel on happen against a running
 * channel, not in a credential list.
 */

import { DISCORD_BOT_TOKEN_KEY } from "../channels/discord/index.js";
import {
  describeChannelLockConflict,
  isChannelLockConflict,
} from "../channels/channel-lock-error.js";
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
const TOKEN_SHAPE =
  /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/;

export const discordIntegration: IntegrationDescriptor = {
  id: "discord",
  label: "Discord",
  summary:
    "Drive the agent from Discord — DM the bot or @mention it in a channel",
  docsUrl: "https://discord.com/developers/applications",
  // Live since the hub stopped relying on `restart()`: the token is
  // resolved at start(), the kill switch and the owner have their own
  // live mutators. See AGENTS.md §"Integrations hub".
  appliesLive: true,
  setupSteps: [
    "Open discord.com/developers/applications → New Application, give it a name.",
    "Left menu → Bot → Reset Token → copy it. The client secret and public key are NOT it.",
    "Leave all three Privileged Gateway Intents OFF — the bot never needs them.",
    "Left menu → OAuth2 → URL Generator: tick the `bot` scope.",
    "Below that tick Send Messages, Read Message History and View Channels.",
    "Open the generated URL, pick your server, authorise. You can only DM a bot you share a server with.",
    "Discord → Settings → Advanced → Developer Mode on, right-click yourself → Copy User ID.",
    "Paste both below (e edits, enter saves), then set Channel to on.",
    "DM the bot, or @mention it in a server channel. It answers only you.",
  ],
  fields: [
    {
      key: TOKEN_FIELD,
      label: "Bot token",
      envVar: DISCORD_BOT_TOKEN_KEY,
      secret: true,
      required: true,
      help: "Developer Portal → your app → Bot → Reset Token. Three chunks split by dots.",
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
      help: "Yours: Settings → Advanced → Developer Mode, right-click your name → Copy User ID. Only this account may drive the agent.",
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
      help: "on connects the bot; off disconnects without forgetting the token. Enter toggles.",
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
      case "down": {
        const reason = ctx.channelErrors?.get("discord");
        // Another process already running the channel is not a
        // failure -- the bot is up, just not served from here.
        if (isChannelLockConflict(reason)) {
          return {
            level: "configured",
            detail: describeChannelLockConflict(reason!),
          };
        }
        // The channel's own reason, never a pointer to a tab that does
        // not exist.
        return { level: "error", detail: reason ?? "gateway failed" };
      }
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
