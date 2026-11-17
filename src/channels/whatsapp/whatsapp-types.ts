/**
 * Shared shapes and pure helpers for the WhatsApp channel (ATO-502).
 *
 * The channel speaks the unofficial WhatsApp Web protocol through the
 * `baileys` library, but nothing in this file knows about baileys: the
 * raw message type below is the small structural subset we read, so the
 * parsing, owner matching and disconnect handling are testable with
 * plain objects.
 */

import type { ExtraChannelConfig } from "../../config/extra-channel-config.js";

export const WHATSAPP_CHANNEL_ID = "whatsapp";

/** WhatsApp allows far more, but long walls of text read badly on a phone. */
export const WHATSAPP_MESSAGE_LIMIT = 2000;

/** Printed in the log and the QR file every time the channel starts pairing. */
export const WHATSAPP_UNOFFICIAL_WARNING =
  "WhatsApp is connected through the unofficial WhatsApp Web protocol (the same one " +
  "WhatsApp Web uses, not Meta's Cloud API). WhatsApp may restrict or ban a number " +
  "that is used this way. Use a spare number you can afford to lose, not your main one.";

export const WHATSAPP_MODULE_MISSING =
  "WhatsApp support is not available in this build (the baileys module could not be " +
  "loaded). Run atomic-agent from npm or from source to use the WhatsApp channel.";

/** The adapter's own `channels.whatsapp.options`, validated. */
export interface WhatsAppOptions {
  /** Act on owner messages inside group chats too (default: DMs only). */
  allowGroups: boolean;
}

export function readWhatsAppOptions(config: ExtraChannelConfig): WhatsAppOptions {
  const raw = config.options.allowGroups;
  return { allowGroups: raw === true || raw === "true" || raw === 1 };
}

/**
 * Canonical form of a WhatsApp id, used for owner matching and chat keys.
 *
 * Accepts what an operator is likely to type into `ownerIds`
 * (`+1 555 000 2222`, `15550002222`) and what WhatsApp hands us
 * (`15550002222@s.whatsapp.net`, `15550002222:7@s.whatsapp.net` with a
 * device suffix, the legacy `@c.us`, a privacy id `123456@lid`, a group
 * `...@g.us`). A bare number becomes a user JID; the device suffix is
 * dropped because every linked device of the owner is still the owner.
 */
export function normalizeWhatsAppId(raw: string): string {
  const value = raw.trim();
  const at = value.indexOf("@");
  if (at === -1) {
    const digits = value.replace(/[^\d]/g, "");
    return digits.length > 0 ? `${digits}@s.whatsapp.net` : value.toLowerCase();
  }
  const user = value.slice(0, at).split(":")[0] ?? "";
  let server = value.slice(at + 1).toLowerCase();
  if (server === "c.us") server = "s.whatsapp.net";
  return `${user}@${server}`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** Status updates, broadcast lists and channels (newsletters) are never chats with an owner. */
export function isBroadcastJid(jid: string): boolean {
  return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

/** The subset of a baileys `WAMessage` this channel reads. */
export interface RawWhatsAppMessage {
  key?: {
    remoteJid?: string | null;
    /** Phone-number JID when `remoteJid` is a privacy id (`@lid`), and the other way round. */
    remoteJidAlt?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
  } | null;
  pushName?: string | null;
  message?: RawWhatsAppContent | null;
}

export interface RawWhatsAppContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null } | null;
  audioMessage?: unknown;
  stickerMessage?: unknown;
  ephemeralMessage?: { message?: RawWhatsAppContent | null } | null;
  viewOnceMessage?: { message?: RawWhatsAppContent | null } | null;
  viewOnceMessageV2?: { message?: RawWhatsAppContent | null } | null;
  documentWithCaptionMessage?: { message?: RawWhatsAppContent | null } | null;
  [key: string]: unknown;
}

/** One inbound message the channel may act on. */
export interface WhatsAppInbound {
  /** WhatsApp message id, for de-duplicating a redelivery. */
  id: string | null;
  /** The chat to reply in: the DM partner's JID or the group JID. */
  chatJid: string;
  /** Every normalized id the sender is known by (phone JID and/or privacy id). */
  senderIds: string[];
  senderName: string | null;
  text: string;
  isGroup: boolean;
  /** True when the message carried a photo, video, voice note, file or sticker. */
  hasMedia: boolean;
}

/**
 * Why a raw message is not acted on, or the message itself. The reasons
 * are only used for tests and debug logs; none carries a phone number.
 */
export type InboundParse =
  | { kind: "message"; message: WhatsAppInbound }
  | { kind: "ignore"; reason: "no-key" | "from-me" | "broadcast" | "empty" };

/** Turn a raw message into something to act on, or a reason to drop it. */
export function parseWhatsAppMessage(raw: RawWhatsAppMessage): InboundParse {
  const key = raw.key;
  const remote = nonEmpty(key?.remoteJid);
  if (!key || remote === null) return { kind: "ignore", reason: "no-key" };
  // Our own sends (including from the phone the bot number lives on).
  if (key.fromMe === true) return { kind: "ignore", reason: "from-me" };
  if (isBroadcastJid(remote)) return { kind: "ignore", reason: "broadcast" };

  const content = unwrap(raw.message ?? null);
  const text = textOf(content);
  const hasMedia = content !== null && MEDIA_KEYS.some((k) => content[k] != null);
  if (text.trim().length === 0 && !hasMedia) return { kind: "ignore", reason: "empty" };

  const isGroup = isGroupJid(remote);
  const senderRaw = isGroup
    ? [key.participant, key.participantAlt]
    : [remote, key.remoteJidAlt];
  const senderIds = unique(
    senderRaw.map((v) => nonEmpty(v)).filter((v): v is string => v !== null).map(normalizeWhatsAppId),
  );
  if (senderIds.length === 0) return { kind: "ignore", reason: "no-key" };
  return {
    kind: "message",
    message: {
      id: nonEmpty(key.id),
      chatJid: remote,
      senderIds,
      senderName: nonEmpty(raw.pushName),
      text,
      isGroup,
      hasMedia,
    },
  };
}

/** Session-map key: one conversation per DM partner and per group. */
export function chatKeyOf(msg: Pick<WhatsAppInbound, "chatJid" | "isGroup">): string {
  return `${msg.isGroup ? "group" : "dm"}:${normalizeWhatsAppId(msg.chatJid)}`;
}

/** What to do after the WhatsApp Web socket closed. */
export interface CloseDecision {
  action: "reconnect-now" | "reconnect-later" | "stop";
  /** Delete the saved session keys: WhatsApp says this device is no longer linked. */
  clearAuth: boolean;
  /** One line for `lastError`. */
  message: string;
}

// The numbers baileys reports in `lastDisconnect.error.output.statusCode`
// (its `DisconnectReason` enum), kept here so this file needs no import.
const LOGGED_OUT = 401;
const FORBIDDEN = 403;
const TIMED_OUT = 408;
const CONNECTION_REPLACED = 440;
const BAD_SESSION = 500;
const RESTART_REQUIRED = 515;

export const WHATSAPP_PAIR_AGAIN =
  "WhatsApp logged this device out. Pair again: restart the WhatsApp channel and scan the new QR code.";

/**
 * Decide how to handle a closed socket.
 *
 * `pairing` is true when this connection showed a QR code and never
 * opened: a timeout then means nobody scanned it, and reconnecting would
 * only print QR codes forever.
 */
export function classifyClose(statusCode: number | null, reason: string, pairing: boolean): CloseDecision {
  switch (statusCode) {
    case LOGGED_OUT:
      return { action: "stop", clearAuth: true, message: WHATSAPP_PAIR_AGAIN };
    case RESTART_REQUIRED:
      // Normal right after a QR scan: WhatsApp asks the new device to reconnect.
      return { action: "reconnect-now", clearAuth: false, message: "WhatsApp asked to reconnect" };
    case CONNECTION_REPLACED:
      return {
        action: "stop",
        clearAuth: false,
        message:
          "Another WhatsApp Web session for this number took over. Stop the other one, then restart the WhatsApp channel.",
      };
    case FORBIDDEN:
      return {
        action: "stop",
        clearAuth: false,
        message: "WhatsApp refused this number (403). It may be restricted or banned.",
      };
    case BAD_SESSION:
      return {
        action: "stop",
        clearAuth: false,
        message:
          "The saved WhatsApp session is damaged. Delete whatsapp-auth in the state folder and pair again.",
      };
    default:
      if (pairing && (statusCode === TIMED_OUT || /qr refs/i.test(reason))) {
        return {
          action: "stop",
          clearAuth: false,
          message: "The QR code was not scanned in time. Restart the WhatsApp channel to get a new one.",
        };
      }
      return {
        action: "reconnect-later",
        clearAuth: false,
        message: `WhatsApp connection lost${statusCode !== null ? ` (${statusCode})` : ""}: ${scrubWhatsAppError(reason)}`,
      };
  }
}

/** One line safe for logs and hosts: no long key-like strings, no phone numbers. */
export function scrubWhatsAppError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/(authorization|token|password|key)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "<redacted>")
    .replace(/\+?\d{7,15}(?=@|\b)/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const MEDIA_KEYS = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
] as const;

/** Disappearing, view-once and captioned-document messages wrap the real content. */
function unwrap(content: RawWhatsAppContent | null): RawWhatsAppContent | null {
  let current = content;
  for (let i = 0; i < 4 && current !== null; i++) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message ??
      null;
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

function textOf(content: RawWhatsAppContent | null): string {
  if (content === null) return "";
  return (
    nonEmpty(content.conversation) ??
    nonEmpty(content.extendedTextMessage?.text) ??
    nonEmpty(content.imageMessage?.caption) ??
    nonEmpty(content.videoMessage?.caption) ??
    nonEmpty(content.documentMessage?.caption) ??
    ""
  );
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
