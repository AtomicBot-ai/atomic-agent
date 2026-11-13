/**
 * Decode what arrives on the subscription, and the text helpers the
 * inbound path needs.
 *
 * A Chat app with a Pub/Sub connection publishes each interaction event
 * as one Pub/Sub message whose `data` is the base64 of the event JSON
 * (`type` = `MESSAGE`, `ADDED_TO_SPACE`, `REMOVED_FROM_SPACE`,
 * `CARD_CLICKED`, ...). Everything off the wire is checked structurally
 * here; downstream code relies only on the fields typed below.
 */

import { GOOGLE_CHAT_MESSAGE_LIMIT, type GoogleChatUserRef } from "./googlechat-types.js";

export interface GoogleChatUser extends GoogleChatUserRef {
  displayName?: string;
}

export interface GoogleChatEvent {
  type?: string;
  space?: { name?: string; type?: string; spaceType?: string };
  message?: {
    name?: string;
    text?: string;
    /** The text without the leading @mention of the app. */
    argumentText?: string;
    thread?: { name?: string };
    sender?: GoogleChatUser;
    attachment?: unknown[];
  };
  user?: GoogleChatUser;
}

/** Larger payloads are not Chat events we can use; skip without parsing. */
const MAX_EVENT_BYTES = 512 * 1024;

/** Base64 Pub/Sub `data` → Chat event, or `null` when it is not one. */
export function decodeGoogleChatEvent(data: string | undefined): GoogleChatEvent | null {
  if (typeof data !== "string" || data.length === 0 || data.length > (MAX_EVENT_BYTES * 4) / 3 + 4) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const event = parsed as GoogleChatEvent;
  return typeof event.type === "string" ? event : null;
}

/** The request text of a MESSAGE event: mention stripped, trimmed. */
export function googleChatRequestText(event: GoogleChatEvent): string {
  const msg = event.message;
  const raw =
    typeof msg?.argumentText === "string"
      ? msg.argumentText
      : typeof msg?.text === "string"
        ? msg.text
        : "";
  return raw.trim();
}

/**
 * `[from] platform=googlechat user=users/123 chat=spaces/AAA`. Ids only,
 * through a strict allowlist, so a value can never leave its field or
 * open a new line. The display name is not included: it is free text
 * chosen by the sender.
 */
export function googleChatSenderLine(userName: string | undefined, spaceName: string): string {
  const parts = ["[from]", "platform=googlechat"];
  const user = sanitizeId(userName ?? "");
  const space = sanitizeId(spaceName);
  if (user) parts.push(`user=${user}`);
  if (space) parts.push(`chat=${space}`);
  return parts.join(" ");
}

function sanitizeId(raw: string): string | undefined {
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 128);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Split `text` into pieces of at most `limit` characters, preferring a
 * paragraph break, then a line break, then a space, near the end of each
 * piece. Never returns an empty list for non-empty input.
 */
export function chunkGoogleChatText(text: string, limit = GOOGLE_CHAT_MESSAGE_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const floor = Math.floor(limit / 2);
    let cut = window.lastIndexOf("\n\n");
    if (cut < floor) cut = window.lastIndexOf("\n");
    if (cut < floor) cut = window.lastIndexOf(" ");
    if (cut < floor) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out.filter((piece, i) => piece.length > 0 || i === 0);
}
