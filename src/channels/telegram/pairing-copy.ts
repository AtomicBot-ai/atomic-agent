/**
 * The operator-facing lines for Telegram pairing (ATO-718), shared by
 * every surface that opens a window (TUI integrations hub, `/telegram
 * pair`, the swarm panel) so they cannot drift. These are for the
 * operator's own screen: the code is never logged or sent anywhere.
 * No em dashes in user-facing text.
 */

/** What to send, to which bot, and how long the code lives. */
export function pairingInstruction(input: {
  code: string;
  botUsername: string | null;
  timeoutMs: number;
}): string {
  const bot = input.botUsername ? `@${input.botUsername}` : "your bot";
  const minutes = Math.max(1, Math.round(input.timeoutMs / 60_000));
  const window = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `Send /start ${input.code} to ${bot} in Telegram within ${window}. The code works once; other messages are ignored.`;
}

/** A Telegram bot @username: 5 to 32 letters, digits or underscores. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
/** A pairing code as `pairing-mode.ts` makes it. */
const CODE = /^\d{6}$/;

/**
 * The deep link that opens the bot with the code filled in (ATO-516):
 * `https://t.me/<bot>?start=<code>`. Telegram shows a Start button and
 * then sends `/start <code>` from that account, which is exactly the
 * message `pairing-mode.ts` accepts, so the link and typing the code by
 * hand claim the same window. `null` when the bot's @username is not
 * known yet or either part is not the shape it must be, so a caller
 * never shows a link that cannot work. It carries the code, so it goes
 * only where the code goes: the operator's own screen.
 */
export function pairingDeepLink(
  botUsername: string | null,
  code: string,
): string | null {
  if (!botUsername || !BOT_USERNAME.test(botUsername)) return null;
  if (!CODE.test(code)) return null;
  return `https://t.me/${botUsername}?start=${code}`;
}

/** Who became the owner, by @username when the account has one. */
export function pairedOwnerLine(claim: {
  userId: number;
  username: string | null;
}): string {
  return claim.username
    ? `Paired: @${claim.username} is now the owner.`
    : `Paired: Telegram user ${claim.userId} (no @username) is now the owner.`;
}

/** The confirmation asked before a window may replace a paired owner. */
export function replaceOwnerPrompt(input: {
  ownerUserId: number;
  confirmSeconds: number;
  again: string;
}): string {
  return `This bot already has an owner (Telegram user ${input.ownerUserId}). ${input.again} within ${input.confirmSeconds} seconds to replace them.`;
}
