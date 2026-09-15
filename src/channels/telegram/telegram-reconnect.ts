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
 * long to wait, when an outage is over -- plus the single one-shot
 * timer. `TelegramChannel` owns the lifecycle the timer re-enters.
 *
 * Not periodic work: one `unref`'d timer at a time, armed only after a
 * failure and cancelled by `stop()`, so it stays inside the polling
 * carve-out (AGENTS.md §"Telegram remote-control channel").
 */

import { backoffMs } from "../reconnect-backoff.js";

/**
 * How long the channel must stay `up` before its next unexpected stop
 * counts as a new outage (attempt 1) instead of the next rung of the
 * current one.
 *
 * `up` is declared as soon as polling is launched, before Telegram has
 * answered a single `getUpdates`, so reaching it proves little. Staying
 * there for one full long-poll round (grammy holds each request for 30 s)
 * does. A stop that recurs straight after every `up` therefore keeps
 * backing off to the cap instead of retrying every second forever.
 */
export const RECONNECT_STABLE_UP_MS = 30_000;

/**
 * Bot API error codes no retry will fix.
 *
 * - 401: the token is invalid or was revoked in @BotFather.
 * - 404: the token is malformed -- the Bot API has no route for it.
 * - 409: another process is long-polling this bot. Retrying would fight
 *   it for updates: each of our polls terminates its poll and vice versa.
 *
 * grammy already retries network failures, 429 and 5xx inside its own
 * polling loop and rethrows exactly 401 and 409 out of it.
 */
const FATAL_ERROR_CODES: ReadonlySet<number> = new Set([401, 404, 409]);

/**
 * True for a Bot API rejection that must not be retried.
 *
 * Duck-typed on `GrammyError.error_code` because grammy may only be
 * imported by `telegram-bot-factory.ts`. A network failure (`HttpError`)
 * carries no `error_code`, so it stays retryable.
 */
export function isFatalTelegramError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { error_code?: unknown }).error_code;
  return typeof code === "number" && FATAL_ERROR_CODES.has(code);
}

/** The retry `schedule()` just armed. */
export interface ReconnectAttempt {
  /** 1-based rung within the current outage. */
  attempt: number;
  delayMs: number;
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

export interface TelegramReconnectOptions {
  /** Test seam: jitter source for `backoffMs`. */
  random?: () => number;
  /** Test seam: clock for the stability window. */
  now?: () => number;
}

export class TelegramReconnect {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
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
   * Replaces a timer that is still armed, so there is never more than one.
   */
  schedule(run: () => void): ReconnectAttempt {
    if (
      this.upSince !== null &&
      this.now() - this.upSince >= RECONNECT_STABLE_UP_MS
    ) {
      this.attempt = 0;
    }
    this.upSince = null;
    this.attempt += 1;
    const delayMs = backoffMs(this.attempt, this.options.random);
    this.clearTimer();
    const timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delayMs);
    // A waiting retry must never be what keeps a shutting-down process alive.
    timer.unref?.();
    this.timer = timer;
    return { attempt: this.attempt, delayMs };
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
    this.upSince = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
