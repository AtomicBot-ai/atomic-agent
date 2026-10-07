/**
 * Supervision for the Telegram long-poll loop.
 *
 * When grammy's `bot.start()` settled without a `stop()` we asked for,
 * the channel used to land in `down` for good: the process kept running,
 * looked healthy, and ignored every message until someone restarted it.
 * The Discord gateway has always reconnected; this gives the Telegram
 * channel the same behaviour on the same backoff schedule.
 *
 * This module is the policy -- which failures are worth retrying, how
 * long to wait, when an outage is over, when a poll that keeps failing
 * counts as a lost connection -- plus the single one-shot timer.
 * `TelegramChannel` owns the lifecycle the timer re-enters.
 *
 * Not periodic work: one `unref`'d timer at a time, armed only after a
 * failure and cancelled by `stop()`, so it stays inside the polling
 * carve-out (../docs/adapters.md).
 */

import { backoffMs } from "../reconnect-backoff.js";

/**
 * How long the channel must stay `up` before its next unexpected stop
 * counts as a new outage (attempt 1) instead of the next rung of the
 * current one.
 *
 * `up` is declared as soon as polling is launched, before Telegram has
 * answered a single `getUpdates`, so reaching it proves little. Staying
 * there for two full long-poll rounds (grammy holds each request for
 * 30 s) does. A stop that recurs straight after every `up` -- or a
 * connection that never answers a poll and is called lost after
 * `POLL_STALL_MS` -- therefore keeps backing off to the cap instead of
 * retrying every second forever.
 */
export const RECONNECT_STABLE_UP_MS = 60_000;

/**
 * How long `getUpdates` may go without an answer from Telegram, while
 * grammy keeps retrying it inside its own loop, before the channel
 * calls the connection lost and replaces the poller.
 *
 * grammy retries a failed poll every 3 s for ever and tells no one, so
 * without this a dead network read as a healthy `up` channel that
 * simply received nothing. Two long-poll rounds: a single failure right
 * at the end of a healthy 30 s poll must not count.
 */
export const POLL_STALL_MS = 60_000;

/**
 * Between retries while another process polls this bot (a 409). Long on
 * purpose: on the normal schedule our polls would keep terminating the
 * other poller's and it ours, and neither would receive anything.
 */
export const CONFLICT_RETRY_MS = 5 * 60_000;

/** Spread on `CONFLICT_RETRY_MS`, so two installs do not retry in step. */
export const CONFLICT_JITTER_MS = 30_000;

/**
 * What a polling failure means for the retry loop.
 *
 * - `fatal`: no retry can fix it. 401 -- the token is invalid or was
 *   revoked in @BotFather; 404 -- the token is malformed, the Bot API has
 *   no route for it. The channel stays `down` and says so once.
 * - `conflict`: 409, another process is long-polling this bot. Not
 *   fatal -- the other poller is often a second install closed again a
 *   minute later -- but retried only every `CONFLICT_RETRY_MS`.
 * - `transient`: everything else. A network failure (`HttpError`
 *   carries no `error_code`), a 429, a 5xx. Retried on the shared
 *   backoff for as long as it lasts.
 *
 * grammy itself retries network failures, 429 and 5xx inside its own
 * polling loop and rethrows exactly 401 and 409 out of it.
 */
export type TelegramFailureKind = "fatal" | "conflict" | "transient";

/**
 * Why the channel is waiting to retry. `locked` is the channel's own
 * single-instance lock held by another atomic-agent: retried on the
 * normal schedule, so a restart that briefly overlaps the old process
 * comes back within seconds, but reported only once.
 */
export type ReconnectKind = Exclude<TelegramFailureKind, "fatal"> | "locked";

/**
 * Classify a polling or startup failure.
 *
 * Duck-typed on `GrammyError.error_code` because grammy may only be
 * imported by `telegram-bot-factory.ts`.
 */
export function classifyTelegramFailure(err: unknown): TelegramFailureKind {
  if (typeof err !== "object" || err === null) return "transient";
  const code = (err as { error_code?: unknown }).error_code;
  if (code === 401 || code === 404) return "fatal";
  if (code === 409) return "conflict";
  return "transient";
}

/** The retry `schedule()` just armed. */
export interface ReconnectAttempt {
  /** 1-based rung within the current outage. */
  attempt: number;
  delayMs: number;
  kind: ReconnectKind;
  /**
   * The first retry of this outage, or the first since its cause
   * changed kind. A conflict or a lock held elsewhere can last as long
   * as the other process runs, so only this one is reported loudly.
   */
  firstOfKind: boolean;
}

/**
 * The `lastError` shown while a retry is armed: the cause, then when the
 * next attempt runs. Rounded up so a sub-second delay never reads "0s".
 */
export function formatReconnectingError(
  cause: string,
  next: ReconnectAttempt,
): string {
  const seconds = Math.ceil(next.delayMs / 1000);
  return `${cause} — reconnecting in ${seconds}s (attempt ${next.attempt})`;
}

/**
 * The `lastError` while another atomic-agent holds the lock. Constant on
 * purpose: the retries behind it run for as long as the other process
 * does, and a countdown would emit a fresh status -- a stderr line in
 * `atomic-agent run` -- on every one of them.
 */
export function formatLockWaitError(cause: string): string {
  return `${cause} — will start here once it stops`;
}

/** The `lastError` once the channel has given up on a rejected token. */
export function formatGivingUpError(cause: string): string {
  return `${cause} — Telegram rejected the bot token; not retrying until it is replaced`;
}

export interface TelegramReconnectOptions {
  /** Test seam: jitter source for `backoffMs` and the conflict wait. */
  random?: () => number;
  /** Test seam: clock for the stability window. */
  now?: () => number;
}

export class TelegramReconnect {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastKind: ReconnectKind | null = null;
  private upSince: number | null = null;

  constructor(private readonly options: TelegramReconnectOptions = {}) {}

  /** A retry timer is armed and has not fired yet. */
  pending(): boolean {
    return this.timer !== null;
  }

  /**
   * An outage is being retried: from the first `schedule()` until
   * `cancel()`. Stays true while the timer's own `start()` is in flight,
   * which is what lets a failed retry arm the next one.
   */
  inOutage(): boolean {
    return this.attempt > 0;
  }

  /** The current rung, `0` outside an outage. */
  currentAttempt(): number {
    return this.attempt;
  }

  /** The channel reached `up`; opens the stability window. */
  markUp(): void {
    this.upSince = this.now();
  }

  /**
   * Arm the next retry and return its rung and delay. The count starts
   * over when the channel had stayed `up` for `RECONNECT_STABLE_UP_MS`.
   * A conflict waits `CONFLICT_RETRY_MS` plus jitter whatever the rung;
   * everything else climbs the shared backoff. Replaces a timer that is
   * still armed, so there is never more than one.
   */
  schedule(
    run: () => void,
    kind: ReconnectKind = "transient",
  ): ReconnectAttempt {
    if (
      this.upSince !== null &&
      this.now() - this.upSince >= RECONNECT_STABLE_UP_MS
    ) {
      this.attempt = 0;
      this.lastKind = null;
    }
    this.upSince = null;
    this.attempt += 1;
    const firstOfKind = this.lastKind !== kind;
    this.lastKind = kind;
    const random = this.options.random ?? Math.random;
    const delayMs =
      kind === "conflict"
        ? CONFLICT_RETRY_MS + Math.floor(random() * CONFLICT_JITTER_MS)
        : backoffMs(this.attempt, random);
    this.clearTimer();
    const timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delayMs);
    // A waiting retry must never be what keeps a shutting-down process alive.
    timer.unref?.();
    this.timer = timer;
    return { attempt: this.attempt, delayMs, kind, firstOfKind };
  }

  /**
   * Disarm the timer but stay in the outage: a `start()` from elsewhere
   * supersedes the retry, and if that start fails too the backoff
   * carries on from the same rung.
   */
  clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** End the outage: disarm the timer and forget the attempt count. */
  cancel(): void {
    this.clearTimer();
    this.attempt = 0;
    this.lastKind = null;
    this.upSince = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
