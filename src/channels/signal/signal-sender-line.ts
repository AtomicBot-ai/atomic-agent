/**
 * The `[from]` line for a Signal group message (ATO-629).
 *
 * Same shape and the same safety rules as `formatSenderLine` in
 * ../sender-identity.ts (the display name is attacker-chosen text and
 * goes through `sanitizeDisplayName`), written here because that
 * module's `SenderPlatform` is a closed union and its id allowlist
 * drops the `+` of a phone number and the `/` `=` of a base64 group id.
 * Ids keep only characters that cannot open a new field: no space, no
 * quote, no newline.
 */

import { sanitizeDisplayName } from "../sender-identity.js";
import type { SignalInbound } from "./signal-types.js";

const ID_MAX_CHARS = 64;

function sanitizeSignalId(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const cleaned = raw.replace(/[^A-Za-z0-9+/=_-]/g, "").slice(0, ID_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function formatSignalSenderLine(msg: SignalInbound): string {
  const parts = ["[from]"];
  const name = sanitizeDisplayName(msg.senderName ?? undefined);
  if (name !== undefined) parts.push(`name="${name}"`);
  parts.push("platform=signal");
  // The UUID when we have one: a phone number is personal data and the
  // prompt may go to a cloud provider.
  const preferred = msg.senderIds.find((id) => !id.startsWith("+")) ?? msg.senderIds[0];
  const user = sanitizeSignalId(preferred ?? null);
  if (user !== undefined) parts.push(`user=${user}`);
  const chat = sanitizeSignalId(msg.groupId);
  if (chat !== undefined) parts.push(`chat=${chat}`);
  return parts.join(" ");
}
