/**
 * Reconnect backoff shared by the channels that hold a long-lived
 * connection to their platform: the Discord gateway socket
 * (`discord/discord-gateway.ts`) and the Telegram long-poll loop
 * (`telegram/telegram-reconnect.ts`).
 *
 * One schedule for both, so a flapping network backs every channel off
 * the same way and a tuning change lands everywhere at once.
 */

/** Backoff ceiling. Discord's session-start budget is per-day, so a
 * flapping network must not be allowed to spin. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * Full-jitter exponential backoff.
 *
 * Full jitter rather than plain exponential because every atomic-agent
 * install pointed at the same bot would otherwise retry in lockstep
 * after a platform incident and hammer it on recovery.
 */
export function backoffMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 6));
  return Math.floor(random() * ceiling) + 500;
}
