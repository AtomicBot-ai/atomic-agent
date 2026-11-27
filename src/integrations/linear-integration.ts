/**
 * Linear as an Integrations-hub tenant (ATO-2464).
 *
 * The same settings `atag connect linear` writes, editable in the TUI:
 * the API key and the webhook signing secret through the key store, and
 * `channels.linear` (owners, on/off, polling or webhook) in config. The
 * channel reads them when it starts, so a change applies after a restart.
 * Installing the agent as a Linear app (OAuth) stays in the CLI wizard,
 * which the walkthrough points to.
 */

import {
  LINEAR_API_KEY_KEY,
  LINEAR_USER_ID_RE,
  LINEAR_WEBHOOK_SECRET_KEY,
} from "../channels/linear/index.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";

const KEY_SHAPE = /^[\x21-\x7e]{20,512}$/;

interface LinearBlock {
  enabled?: unknown;
  ownerIds?: unknown;
  options?: { mode?: unknown };
}

function linearBlock(ctx: IntegrationStatusContext): LinearBlock {
  const channels = ctx.config?.channels;
  const block = channels && typeof channels === "object" ? (channels as Record<string, unknown>).linear : undefined;
  return block && typeof block === "object" ? (block as LinearBlock) : {};
}

/** The channel's mode: an explicit option, else webhook when its secret is saved (linear-types.ts resolveLinearMode). */
function linearMode(ctx: IntegrationStatusContext): "poll" | "webhook" {
  const mode = linearBlock(ctx).options?.mode;
  if (mode === "poll" || mode === "webhook") return mode;
  return ctx.presentFields.has("webhookSecret") ? "webhook" : "poll";
}

export const linearIntegration: IntegrationDescriptor = {
  id: "linear",
  label: "Linear",
  summary: "Mention the agent in a Linear issue comment and it answers in the thread",
  docsUrl: "https://linear.app/settings/account/security",
  appliesLive: false,
  setupSteps: [
    "Quickest: run `atag connect linear` in a terminal; it checks the key and fills all of this in.",
    "Or by hand: Linear → Settings → Account → Security & access → Personal API keys → New key, copy it.",
    "Paste it below as API key, and your Linear user id as Owner user IDs.",
    "Mode `poll` checks Linear every minute, no public address needed.",
    "Mode `webhook` answers at once but needs a tunnel and the signing secret.",
    "Set Channel to on and restart the agent. Then comment `@agent hello` in an issue.",
    "To delegate issues to the agent as a Linear app, run `atag connect linear --app`.",
  ],
  fields: [
    {
      key: "apiKey",
      label: "API key",
      envVar: LINEAR_API_KEY_KEY,
      secret: true,
      required: true,
      help: "Linear → Settings → Account → Security & access → Personal API keys. Starts with lin_api_.",
      validate: (raw) => (KEY_SHAPE.test(raw) ? undefined : "Doesn't look like a Linear API key: one line, no spaces, starts with lin_api_."),
    },
    {
      key: "ownerIds",
      label: "Owner user IDs",
      store: "config",
      kind: "list",
      configPath: "channels.linear.ownerIds",
      secret: false,
      required: true,
      help: "Comma-separated Linear user ids (uuids). Only these users may drive the agent from Linear, approvals included.",
      validate: (raw) => (LINEAR_USER_ID_RE.test(raw) ? undefined : "A Linear user id is a uuid like 2f1c0a4e-1b2c-4d5e-8f90-123456789abc."),
    },
    {
      key: "enabled",
      label: "Channel",
      kind: "boolean",
      store: "config",
      configPath: "channels.linear.enabled",
      secret: false,
      required: false,
      help: "on starts the Linear channel at the next start; off stops it without forgetting the key. Enter toggles.",
    },
    {
      key: "mode",
      label: "Mode",
      store: "config",
      configPath: "channels.linear.options.mode",
      secret: false,
      required: false,
      help: "poll (default, no public address) or webhook (needs a tunnel and the signing secret).",
      validate: (raw) => (raw === "poll" || raw === "webhook" ? undefined : "Mode is poll or webhook."),
    },
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      envVar: LINEAR_WEBHOOK_SECRET_KEY,
      secret: true,
      required: false,
      help: "Only for webhook mode: Linear → Settings → API → Webhooks → your webhook → signing secret.",
      validate: (raw) => (KEY_SHAPE.test(raw) ? undefined : "Doesn't look like a signing secret: one line, no spaces."),
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!ctx.presentFields.has("apiKey")) return { level: "not_configured", detail: "no API key" };
    if (!isConfigured(linearIntegration, ctx.presentFields)) return { level: "not_configured", detail: "no owner: add your Linear user id" };
    const mode = linearMode(ctx);
    if (mode === "webhook" && !ctx.presentFields.has("webhookSecret")) {
      return { level: "error", detail: "webhook mode needs the signing secret, or set Mode to poll" };
    }
    if (linearBlock(ctx).enabled !== true) return { level: "configured", detail: "channel off" };
    return {
      level: "configured",
      detail: mode === "poll" ? "polling Linear every minute (after a restart)" : "webhook (after a restart; keep the tunnel running)",
    };
  },
};
