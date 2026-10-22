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
