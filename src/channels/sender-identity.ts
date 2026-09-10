/**
 * Tell the model *who* is speaking and *where*.
 *
 * Until now an inbound channel message reached `runtime.runTurn` as
 * bare text: the agent saw "restart the deploy" with no idea whether it
 * came from the person who set the bot up, from a second operator in a
 * shared guild, or from a group topic it should keep separate. That was
 * survivable while a channel had exactly one owner. It stopped being
 * survivable when Discord grew `ownerUserIds` (a *list*): several people
 * now legitimately drive one bot and the model cannot tell them apart,
 * so it cannot say "you asked me to X yesterday" to the right person,
 * cannot address anyone by name, and cannot reason about which channel a
 * request belongs to.
 *
 * The fix follows the idiom `buildAttachmentUserMessage` already
 * established for files: prepend one bracketed block onto the user
 * message. This one is a single line, because it rides on *every* turn
 * of a channel conversation and every token is paid for again on each
 * step of the agent loop.
 *
 * SECURITY — this is the one dangerous part of the feature. The display
 * name is attacker-controlled text: anyone who can send the bot a
 * message picks their own nickname, and a nickname is a perfect place to
 * smuggle a forged instruction into the prompt. `sanitizeDisplayName`
 * therefore guarantees the rendered line is *exactly one line*: every
 * control character, newline and Unicode line/paragraph separator is
 * removed before the name is embedded, and the name is emitted inside
 * double quotes with `"` and `\` escaped. A name cannot then
 *   - open a new line at all (no newline survives), so it cannot forge a
 *     second `[from]` line, an `[attachments]` block, or any other
 *     line-anchored marker the prompt builder uses;
 *   - escape its own quoted field (quotes and backslashes are escaped);
 *   - blow up the prompt (hard length cap).
 * The ids get the same treatment plus a strict character allowlist —
 * they come off the wire through a structural `as` cast, so "it is a
 * snowflake" is an assumption, not a checked fact.
 *
 * What this does NOT do, so nobody builds on a guarantee that is not
 * here:
 *   - it does not make `[from]` unique in the message. Only the name
 *     is escaped; the payload below it is not, so a message body or an
 *     attachment filename can render another line-anchored `[from]`.
 *     The envelope is "the first line", not "the `[from]` line" — see
 *     `withSenderIdentity`.
 *   - it does not bound the rendered name at `SENDER_NAME_MAX_CHARS`.
 *     The cap is on the visible name and escaping can double it, so
 *     the real ceiling is `2 * SENDER_NAME_MAX_CHARS + 1`.
 *   - it does not sanitise the *content* of a name, only its shape. A
 *     nickname is prose that reaches the model, the memory recall
 *     query and the reflection runner's extraction input on every
 *     turn. On Discord `member.nick` is settable by anyone in the
 *     guild with Manage Nicknames, who need not be an owner — so that
 *     is a non-owner write into the prompt, structurally inert but
 *     semantically free-form.
 */

/** The platform a channel message arrived on. */
export type SenderPlatform = "discord" | "telegram";

/** Who sent an inbound channel message, and where it landed. */
export interface SenderIdentity {
  platform: SenderPlatform;
  /** Platform display name, as typed by its owner. Untrusted. */
  displayName?: string | undefined;
  /** Platform user id (Discord snowflake / Telegram numeric id). */
  userId: string;
  /** Chat or channel id the message arrived in. */
  chatId: string;
  /** Forum topic / thread id, where the surface has one. */
  threadId?: string | undefined;
}

/**
 * Longest display name that reaches the prompt. Discord caps global
 * names at 32 and guild nicknames at 32; Telegram first+last name can
 * reach 128. 64 keeps every realistic name intact while bounding what a
 * hostile one can spend of the turn's budget.
 */
export const SENDER_NAME_MAX_CHARS = 64;

/** Longest id fragment rendered. Real ids are ≤ 20 characters. */
const ID_MAX_CHARS = 32;

/**
 * Anything that could break the single-line guarantee or steer a
 * renderer: C0/C1 controls (`\n`, `\r`, `\t`, …), format characters
 * (bidi overrides, zero-width joiners), and the Unicode line and
 * paragraph separators. Replaced with a space rather than deleted so
 * "a\nb" reads as "a b" instead of the misleading "ab".
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Collapse an untrusted display name into something that can only ever
 * occupy part of one line. Returns `undefined` when nothing printable
 * is left — the caller then omits the `name=` field entirely rather
 * than rendering an empty pair.
 */
export function sanitizeDisplayName(
  raw: string | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flattened = raw.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  if (flattened.length === 0) return undefined;
  // Truncate the *visible* name, before escaping. That order is what
  // keeps the escaping well formed: cutting the escaped string could
  // land between a `\` and the character it escapes, and the escape
  // pairs are exactly what stops a name leaving its field. (It does
  // NOT bound the rendered field at `SENDER_NAME_MAX_CHARS` — a name
  // of 64 quotes still renders as 128 characters. The cap bounds the
  // name, escaping doubles the worst case, and that ceiling is the
  // one this module promises.)
  //
  // Cut on code points, not UTF-16 units: `slice` on a string whose
  // 64th unit is the high half of a surrogate pair leaves a lone
  // surrogate, which is not valid UTF-8 and gets rewritten to U+FFFD
  // the first time the prompt is encoded for the wire or saved to the
  // session store.
  const points = Array.from(flattened);
  const clipped =
    points.length > SENDER_NAME_MAX_CHARS
      ? `${points.slice(0, SENDER_NAME_MAX_CHARS - 1).join("")}…`
      : flattened;
  return clipped.replace(/[\\"]/gu, (c) => `\\${c}`);
}

/**
 * Ids are structural assumptions, not validated input, so keep only
 * what a real id can contain (digits, plus `-` for Telegram's negative
 * group ids) and cap the length.
 *
 * Offending *characters* are dropped, not the id: `1 1\n1` renders as
 * `111`, and only an id with nothing left renders no field at all. So
 * a malformed id is reported as a plausible-looking wrong one rather
 * than as absent. That is deliberate — the allowlist removes every
 * character that could open a new field (space, `=`, `"`), so a
 * mangled id can still only ever be a wrong value inside its own
 * field, and dropping `chat=` entirely would be the worse failure for
 * a model trying to tell two channels apart. Do not relax the
 * allowlist on the assumption that ids are dropped whole.
 */
function sanitizeId(raw: string | number | undefined): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const cleaned = String(raw).replace(/[^A-Za-z0-9_-]/gu, "");
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, ID_MAX_CHARS);
}

/**
 * The one-line identity block. `key=value` pairs rather than prose so
 * the model can read it unambiguously and a hostile name — which lives
 * inside the quoted `name=` field and cannot leave it — cannot be
 * mistaken for another field.
 *
 * Example:
 *   `[from] name="Ada" platform=discord user=111 chat=c1 thread=t7`
 */
export function formatSenderLine(sender: SenderIdentity): string {
  const name = sanitizeDisplayName(sender.displayName);
  const userId = sanitizeId(sender.userId);
  const chatId = sanitizeId(sender.chatId);
  const threadId = sanitizeId(sender.threadId);
  const parts = ["[from]"];
  if (name !== undefined) parts.push(`name="${name}"`);
  parts.push(`platform=${sender.platform}`);
  if (userId !== undefined) parts.push(`user=${userId}`);
  if (chatId !== undefined) parts.push(`chat=${chatId}`);
  if (threadId !== undefined) parts.push(`thread=${threadId}`);
  return parts.join(" ");
}

/**
 * Prepend the identity line to a user message.
 *
 * ORDERING — the identity line goes *first*, above both the user's text
 * and any `[attachments]` block, and callers compose it as
 * `withSenderIdentity(buildAttachmentUserMessage(...), sender)`. Two
 * reasons, in order of weight:
 *  1. Everything below the line is attacker-controlled (message text,
 *     filenames). Envelope-before-payload means the *authoritative*
 *     `[from]` line is the first line of the message, so anything that
 *     looks like a second one is visibly below it, inside the payload.
 *     The reverse order would let the payload's last line sit flush
 *     against a trailing envelope and read as part of it.
 *
 *     This is a positional guarantee, not a uniqueness one. The
 *     payload is NOT escaped: a message body containing a line
 *     `[from] …`, or an attachment whose filename does, renders a
 *     second line-anchored `[from]` further down. Both surfaces are
 *     gated on the owner allowlist (`ownerUserIds` / `ownerUserId`),
 *     so forging one takes an account that can already drive the bot
 *     outright — but with several owners on Discord that is a real
 *     population, and a model told to trust `[from]` has nothing here
 *     telling it that only the FIRST such line is the envelope. Read
 *     the first line, not "the `[from]` line"; anything stronger needs
 *     either a payload escape or a line in the system prompt, neither
 *     of which this module does.
 *  2. The attachments block ends with a tool hint that talks about the
 *     lines immediately above it; slotting metadata between them would
 *     break that adjacency.
 *
 * `sender === null` returns the message untouched — see
 * `shouldAnnounceSender` for when that happens.
 */
export function withSenderIdentity(
  message: string,
  sender: SenderIdentity | null,
): string {
  if (sender === null) return message;
  return `${formatSenderLine(sender)}\n${message}`;
}

/**
 * When the line is worth its tokens.
 *
 * The rule is deliberately narrow, because the block is paid for on
 * every step of every turn:
 *  - **Discord: always.** A Discord bot is multi-author by nature — a
 *    guild channel has many speakers, and `ownerUserIds` is now a list,
 *    so even the owner set is plural. Nothing here identifies the
 *    speaker for free.
 *  - **Telegram: groups and supergroups only.** A Telegram private chat
 *    reaches the runtime only for the single configured `ownerUserId`,
 *    so in a DM the line would repeat a constant the model can only
 *    learn one thing from — and repeat it forever. In a group (or a
 *    forum topic inside one) the chat and topic ids are real
 *    information even though the sender is still the owner.
 *
 * Deterministic on the chat type alone, so it is testable without a
 * runtime.
 */
export function shouldAnnounceSender(
  platform: SenderPlatform,
  chatType: string,
): boolean {
  if (platform === "discord") return true;
  return chatType === "group" || chatType === "supergroup";
}
