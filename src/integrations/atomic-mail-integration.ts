/**
 * Atomic Mail as an Integrations-hub tenant: the agent's own inbox.
 *
 * Unlike Telegram or Discord there is no token to paste — the inbox is
 * registered with a proof-of-work (`r`), no human step. What the
 * operator supplies is *their* address, proved with a six-digit code
 * the inbox mails them. From then on the agent can reach them, and the
 * agent's own inbox is readable and writable by its tools.
 */

import { ATOMIC_MAIL_API_KEY_KEY } from "../atomic-mail/index.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";

export const ATOMIC_MAIL_INTEGRATION_ID = "atomic-mail";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const atomicMailIntegration: IntegrationDescriptor = {
  id: ATOMIC_MAIL_INTEGRATION_ID,
  label: "Atomic Mail",
  summary: "Your agent's own e-mail address — pings you when a model lands, reads and sends mail",
  docsUrl: "https://atomicmail.ai",
  // Nothing to restart: every field acts the moment it is saved.
  appliesLive: true,
  setupSteps: [
    "Press r — the agent registers its own @atomicmail.ai inbox. No account: a proof-of-work, seconds.",
    "Press e on Your e-mail, type the address to reach you at, press enter — a code is mailed there.",
    "Press e on Verification code, type the six digits, press enter. Downloads can e-mail you now.",
  ],
  fields: [
    {
      key: "address",
      label: "Agent inbox",
      store: "config",
      configPath: "atomicMail.address",
      secret: false,
      required: false,
      readonly: true,
      help: "Assigned at registration. Mail sent here reaches the agent's tools.",
    },
    {
      key: "apiKey",
      label: "API key",
      envVar: ATOMIC_MAIL_API_KEY_KEY,
      secret: true,
      required: true,
      help: "Created by r. Paste one only to reconnect an inbox registered elsewhere.",
    },
    {
      key: "ownerEmail",
      label: "Your e-mail",
      store: "config",
      configPath: "atomicMail.ownerEmail",
      secret: false,
      required: true,
      help: "Where the agent may reach you. Saving it mails you a code.",
      validate: (raw) => (EMAIL_SHAPE.test(raw) ? undefined : "That does not look like an e-mail address."),
    },
    {
      key: "verificationCode",
      label: "Verification code",
      store: "transient",
      secret: false,
      required: false,
      help: "The six digits from the mail. Checked, never stored.",
      validate: (raw) =>
        /^\s*\d{3}\s*-?\s*\d{3}\s*$/.test(raw) ? undefined : "Six digits, as in the mail.",
    },
  ],
  actions: [
    {
      key: "r",
      id: "register",
      label: "register inbox",
      available: (ctx) => !ctx.presentFields.has("apiKey"),
    },
    {
      key: "v",
      id: "resend",
      label: "resend code",
      available: (ctx) => ctx.presentFields.has("apiKey") && ctx.presentFields.has("ownerEmail"),
    },
    {
      key: "x",
      id: "forget",
      label: "forget inbox",
      available: (ctx) => ctx.presentFields.has("apiKey"),
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!ctx.presentFields.has("apiKey")) {
      return { level: "not_configured", detail: "no inbox yet — press r" };
    }
    if (!ctx.presentFields.has("ownerEmail")) {
      return { level: "configured", detail: "inbox ready — add your e-mail" };
    }
    const state = ctx.channelStates?.get(ATOMIC_MAIL_INTEGRATION_ID);
    if (state === "verified") return { level: "connected", detail: "owner verified" };
    if (state === "pending") return { level: "configured", detail: "code sent — press e on Verification code" };
    return { level: "configured", detail: "not verified — press v to get a code" };
  },
};
