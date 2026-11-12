/**
 * Owner matching for the iMessage channel.
 *
 * Messages stores the author of a message as a raw "handle": a phone
 * number (normally E.164, `+14155551212`) or an Apple ID e-mail. The
 * operator types their own handle into `channels.imessage.ownerIds`
 * however they like to write phone numbers, so both sides are
 * normalised before they are compared.
 *
 * Matching is exact after normalisation, never a suffix or "contains"
 * match: a looser rule would let a number that merely ends in the
 * owner's digits drive a shell on the Mac.
 */

/** Separators people put in phone numbers: spaces, dashes, dots, parentheses. */
const PHONE_SEPARATORS = /[\s\-(). ]/g;

/**
 * Canonical form of a handle: e-mails lower-cased, phone numbers with
 * every separator removed (`+1 (415) 555-1212` -> `+14155551212`).
 * Returns `""` for blank input so it never matches anything.
 */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("@")) {
    return trimmed.replace(/^mailto:/i, "").toLowerCase();
  }
  return trimmed.replace(/^tel:/i, "").replace(PHONE_SEPARATORS, "");
}

/** Normalise every configured owner, dropping blanks and duplicates. */
export function normalizeOwnerIds(ownerIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ownerIds) {
    const normalized = normalizeHandle(id);
    if (normalized.length > 0 && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Whether `sender` is one of `owners` (already normalised). An empty
 * owner list matches nobody: an unpaired channel refuses everything.
 */
export function isOwnerHandle(sender: string, owners: readonly string[]): boolean {
  if (owners.length === 0) return false;
  const normalized = normalizeHandle(sender);
  if (normalized.length === 0) return false;
  return owners.includes(normalized);
}

/**
 * A handle safe to put in a log line: the domain of an e-mail and the
 * last two digits of a phone number survive, the rest is masked. Enough
 * to tell "my number" from "a stranger" when the bot ignores a message,
 * without writing contacts into the trace files.
 */
export function maskHandle(raw: string): string {
  const handle = normalizeHandle(raw);
  if (handle.length === 0) return "<none>";
  const at = handle.indexOf("@");
  if (at > 0) return `***${handle.slice(at)}`;
  return handle.length <= 2 ? "**" : `***${handle.slice(-2)}`;
}
