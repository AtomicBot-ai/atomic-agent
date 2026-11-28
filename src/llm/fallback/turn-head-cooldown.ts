/**
 * A short rest for a turn head that failed (ATO-2435).
 *
 * A turn head (`setTurnPrimary`) is put first again at the start of
 * every turn, so the breaker's own cooldown, which only steers the
 * sticky override inside a partition, never keeps the next turn off it.
 * For the local-first cascade (ATO-2208) that meant a local server that
 * hangs until the request timeout cost that wait on every turn. Here a
 * head's failure arms its own cooldown at once (one failure is enough:
 * the cloud link behind it is known good), escalating on each repeat
 * and cleared when the head answers again. The caller that picks heads
 * (`localFirstTurnHead`) skips a head while it rests.
 *
 * Precedent: LiteLLM router cooldowns (a deployment that failed is left
 * out for `cooldown_time`), the circuit breaker pattern.
 *
 * Pure state over the injected clock: no timer.
 */

/** Rest after the 1st, 2nd, 3rd and later failures in a row. */
export const TURN_HEAD_COOLDOWN_MS: readonly number[] = [60_000, 300_000, 900_000];

export interface TurnHeadCooldown {
  /** The head rests until this instant (epoch ms). */
  until: number;
  /** Failures in a row, for the ladder. */
  failures: number;
}

/** Arm or escalate `providerId`'s rest after a failure at `now`. */
export function armTurnHeadCooldown(
  cooldowns: Map<string, TurnHeadCooldown>,
  providerId: string,
  now: number,
  ladder: readonly number[] = TURN_HEAD_COOLDOWN_MS,
): void {
  const failures = (cooldowns.get(providerId)?.failures ?? 0) + 1;
  const step = Math.min(failures, ladder.length) - 1;
  cooldowns.set(providerId, { until: now + (ladder[step] ?? 0), failures });
}

/** Whether `providerId` still rests at `now`. */
export function turnHeadResting(
  cooldowns: ReadonlyMap<string, TurnHeadCooldown>,
  providerId: string,
  now: number,
): boolean {
  const entry = cooldowns.get(providerId);
  return entry !== undefined && now < entry.until;
}
