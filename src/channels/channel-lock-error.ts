/**
 * Shared vocabulary for "this channel is already running somewhere
 * else".
 *
 * Two atomic-agent processes on one bot token is not a failure — it is
 * the normal shape of running the bots in one terminal and opening the
 * TUI in another. The channel in the second process genuinely cannot
 * start, so it reports `down`, but presenting that as a red error is
 * wrong twice: nothing is broken, and the bot the operator cares about
 * is working fine. Red that fires on a healthy system is red people
 * learn to ignore.
 *
 * The lockfiles tag the reason with a stable prefix so the Integrations
 * hub can tell this apart from a real failure (rejected token, bad
 * intents) without pattern-matching on prose.
 */

/** Machine-readable prefix on a lock-conflict reason. */
export const CHANNEL_LOCKED_PREFIX = "channel-locked:";

/**
 * Build the reason a lockfile throws when another live process holds
 * it. The channel name is deliberately left out: the message is
 * rendered on that channel's own row, where repeating it is noise.
 */
export function formatChannelLockHeld(pid: number): string {
  return `${CHANNEL_LOCKED_PREFIX} already running in another atomic-agent (pid ${pid})`;
}

/** True when `reason` is a lock conflict rather than a real failure. */
export function isChannelLockConflict(
  reason: string | null | undefined,
): boolean {
  return typeof reason === "string" && reason.startsWith(CHANNEL_LOCKED_PREFIX);
}

/** The human half of a lock-conflict reason, without the machine prefix. */
export function describeChannelLockConflict(reason: string): string {
  return reason.slice(CHANNEL_LOCKED_PREFIX.length).trim();
}
