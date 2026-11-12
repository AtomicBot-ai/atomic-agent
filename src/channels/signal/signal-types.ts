/**
 * Settings, limits and wire shapes for the Signal channel (ATO-629).
 *
 * We never ship signal-cli (GPL-3.0). The operator installs it, registers
 * or links the bot number, and runs it as a local HTTP daemon:
 *
 *     signal-cli -a +15550001111 daemon --http 127.0.0.1:8080
 *
 * The adapter only speaks that daemon's documented HTTP surface:
 * JSON-RPC on `POST /api/v1/rpc` and the Server-Sent Events stream on
 * `GET /api/v1/events`. See ../docs/adapters.md.
 */

import type { ExtraChannelConfig } from "../../config/extra-channel-config.js";

export const SIGNAL_CHANNEL_ID = "signal";

/** Where `signal-cli daemon --http` listens unless told otherwise. */
export const SIGNAL_DEFAULT_URL = "http://127.0.0.1:8080";

/**
 * Signal has no hard text limit we can rely on (long messages turn into
 * a "read more" attachment on some clients), so replies are cut at a
 * size every client shows inline.
 */
export const SIGNAL_MESSAGE_LIMIT = 2000;

/** The adapter's own `channels.signal.options`, validated. */
export interface SignalOptions {
  /** Daemon base URL, no trailing slash. */
  url: string;
  /** The bot's own number (E.164), as passed to `signal-cli -a`. */
  account: string | null;
  /** Act on owner messages inside groups too (default: DMs only). */
  allowGroups: boolean;
}

/**
 * Read `options` leniently: a wrong type falls back to the default
 * rather than throwing, because the generic config loader already
 * accepted the block and the channel must still settle into a state.
 * A missing `account` reads as `null`, which `start()` turns into
 * `disabled`.
 */
export function readSignalOptions(config: ExtraChannelConfig): SignalOptions {
  const { options } = config;
  const rawUrl = typeof options.url === "string" ? options.url.trim() : "";
  const rawAccount =
    typeof options.account === "string" ? options.account.trim() : "";
  return {
    url: (rawUrl.length > 0 ? rawUrl : SIGNAL_DEFAULT_URL).replace(/\/+$/, ""),
    account: rawAccount.length > 0 ? normalizeSignalId(rawAccount) : null,
    allowGroups: options.allowGroups === true,
  };
}

/**
 * One canonical form for an owner id, so `"+1 555 000 1111"` in config
 * matches `"+15550001111"` on the wire and a UUID matches regardless of
 * case. Phone numbers lose spaces, dashes and brackets; anything else
 * (an ACI UUID) is lower-cased.
 */
export function normalizeSignalId(raw: string): string {
  const trimmed = raw.trim();
  if (/^\+?[\d\s().-]+$/.test(trimmed)) {
    const digits = trimmed.replace(/[^\d]/g, "");
    return `+${digits}`;
  }
  return trimmed.toLowerCase();
}

/**
 * Strip anything that could carry a credential or a phone number we did
 * not mean to print. signal-cli errors can echo the request URL and the
 * recipient; the URL is ours (local), but a bearer-ish token in it, or a
 * long base64 blob, must never reach `lastError` or the logs.
 */
export function scrubSignalError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/(authorization|token|password)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "<redacted>")
    .slice(0, 300);
}

/** The subset of a signal-cli envelope this channel reads. */
export interface SignalEnvelope {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string | null;
    groupInfo?: { groupId?: string; type?: string } | null;
    attachments?: ReadonlyArray<{ filename?: string | null; contentType?: string }>;
  } | null;
}

/** One inbound text message, resolved from an envelope. */
export interface SignalInbound {
  /** Every id the sender is known by, normalized (number and/or UUID). */
  senderIds: string[];
  /** Where a DM reply goes: number when known, else UUID. */
  replyTo: string;
  senderName: string | null;
  text: string;
  /** Base64 group id when the message was posted in a group. */
  groupId: string | null;
  attachmentCount: number;
}

/**
 * Pull the envelope out of one SSE `data:` payload. signal-cli sends
 * `{ envelope, account }`; the JSON-RPC notification wrappers
 * (`params.envelope`, `params.result.envelope`) are accepted too so a
 * future daemon that forwards notifications verbatim still parses.
 */
export function extractEnvelope(
  payload: unknown,
): { envelope: SignalEnvelope; account: string | null } | null {
  if (!isObject(payload)) return null;
  const candidates = [payload, payload.params, isObject(payload.params) ? payload.params.result : undefined];
  for (const c of candidates) {
    if (isObject(c) && isObject(c.envelope)) {
      return {
        envelope: c.envelope as SignalEnvelope,
        account: typeof c.account === "string" ? c.account : null,
      };
    }
  }
  return null;
}

/**
 * Turn an envelope into a text message, or `null` for anything this
 * channel does not act on: receipts, typing notices, sync messages (our
 * own sends echoed from a linked device), reactions, empty bodies.
 */
export function toInbound(envelope: SignalEnvelope): SignalInbound | null {
  const data = envelope.dataMessage;
  if (!data) return null;
  const text = typeof data.message === "string" ? data.message : "";
  const attachmentCount = Array.isArray(data.attachments) ? data.attachments.length : 0;
  if (text.trim().length === 0 && attachmentCount === 0) return null;
  const number = nonEmpty(envelope.sourceNumber) ?? phoneLike(envelope.source);
  const uuid = nonEmpty(envelope.sourceUuid) ?? uuidLike(envelope.source);
  const senderIds = [number, uuid]
    .filter((v): v is string => v !== null)
    .map(normalizeSignalId);
  const replyTo = number ?? uuid;
  if (replyTo === null || senderIds.length === 0) return null;
  const groupId = nonEmpty(data.groupInfo?.groupId ?? null);
  return {
    senderIds,
    replyTo,
    senderName: nonEmpty(envelope.sourceName ?? null),
    text,
    groupId,
    attachmentCount,
  };
}

/** Session-map key: one conversation per DM partner and per group. */
export function chatKeyOf(msg: SignalInbound): string {
  return msg.groupId !== null ? `group:${msg.groupId}` : `dm:${normalizeSignalId(msg.replyTo)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function phoneLike(v: string | undefined): string | null {
  return typeof v === "string" && /^\+\d{6,}$/.test(v) ? v : null;
}

function uuidLike(v: string | undefined): string | null {
  return typeof v === "string" && /^[0-9a-f-]{32,36}$/i.test(v) ? v : null;
}
