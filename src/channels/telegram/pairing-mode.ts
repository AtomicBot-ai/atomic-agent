import type { InboundTextUpdate } from "./inbound-handler.js";

/** Default pairing window. Long enough to read the prompt and DM the bot, short enough to bound exposure. */
export const DEFAULT_PAIRING_TIMEOUT_MS = 60_000;

export interface ClaimedPairing {
  /** Telegram numeric user id of the claimer — written to `telegram.ownerUserId`. */
  userId: number;
  /** DM chat id used to ack the new owner. */
  chatId: number;
}

export interface PairingMode {
  /**
   * Open a pairing window. The returned promise resolves with the
   * claimer's `{ userId, chatId }` when the next eligible DM arrives,
   * or `null` when the window times out or is cancelled. Calling
   * `start()` twice without first cancelling the previous window
   * cancels the old window and starts a fresh one — convenient for
   * "restart pairing" hotkeys, deliberately not an error.
   */
  start(timeoutMs?: number): Promise<ClaimedPairing | null>;
  /** Cancel an active window. No-op when inactive. */
  cancel(): void;
  /** Whether a pairing window is currently open. */
  isActive(): boolean;
  /** Epoch ms when the active window expires, or `null` when inactive. */
  expiresAt(): number | null;
  /**
   * Hook for the inbound handler. Returns `true` when the update was
   * consumed by pairing (and must not be dispatched to the agent loop)
   * and `false` when pairing is inactive or the update is ineligible.
   * Eligibility: private chat, `from.id` present, non-empty text.
   */
  tryClaim(update: InboundTextUpdate): boolean;
}

export interface PairingModeOptions {
  /**
   * Test seam — replace `setTimeout`/`clearTimeout`. Returns a
   * cancel function. The default uses real timers and `unref()`s
   * the handle so an active pairing window does not keep the
   * runtime alive past `runtime.shutdown()`.
   */
  scheduleTimeout?: (cb: () => void, ms: number) => () => void;
  /** Test seam — overrides `Date.now()` for the `expiresAt()` accessor. */
  now?: () => number;
}

interface ActiveSession {
  resolve: (result: ClaimedPairing | null) => void;
  expiresAt: number;
  cancelTimer: () => void;
}

/**
 * Pairing-mode state machine for the Telegram channel.
 *
 * The channel calls `start()` on operator request (TUI button, CLI
 * `pair` command). The first DM that arrives within the window is
 * captured as the new owner; ineligible updates (group chats, bot
 * messages without `from`) are ignored so a stray channel hit does
 * not silently misclaim ownership.
 *
 * Concurrency contract:
 *  - Exactly one active window at a time. `start()` while active
 *    cancels the previous window first (resolves with `null`).
 *  - `tryClaim()` is idempotent across simultaneous calls — only the
 *    first claim resolves the promise; subsequent calls return
 *    `false`. Wired to the fire-and-forget grammy adapter so racing
 *    DMs cannot double-resolve.
 *  - `cancel()` from any caller (channel shutdown, manual TUI cancel,
 *    timeout) resolves with `null`. Idempotent.
 *
 * The state machine deliberately knows nothing about owner config
 * persistence — that's the channel's job. This module is pure logic
 * around a timer, a promise, and a single eligibility check.
 */
export class DefaultPairingMode implements PairingMode {
  private active: ActiveSession | null = null;
  private readonly scheduleTimeout: (
    cb: () => void,
    ms: number,
  ) => () => void;
  private readonly now: () => number;

  constructor(opts: PairingModeOptions = {}) {
    this.scheduleTimeout = opts.scheduleTimeout ?? defaultScheduleTimeout;
    this.now = opts.now ?? Date.now;
  }

  start(timeoutMs: number = DEFAULT_PAIRING_TIMEOUT_MS): Promise<ClaimedPairing | null> {
    if (timeoutMs <= 0) {
      return Promise.resolve(null);
    }
    if (this.active) {
      // Replace: cancel the previous window so its caller learns the
      // outcome (`null`) and we start fresh.
      this.cancel();
    }
    return new Promise<ClaimedPairing | null>((resolve) => {
      const expiresAt = this.now() + timeoutMs;
      const cancelTimer = this.scheduleTimeout(() => {
        // Timer fires synchronously through the fake scheduler in
        // tests; guard against a state where the session was already
        // resolved by a racing `tryClaim` / `cancel`.
        if (this.active && this.active.resolve === resolve) {
          this.active = null;
          resolve(null);
        }
      }, timeoutMs);
      this.active = { resolve, expiresAt, cancelTimer };
    });
  }

  cancel(): void {
    const session = this.active;
    if (!session) return;
    this.active = null;
    try {
      session.cancelTimer();
    } catch {
      // best effort — never let a misbehaving timer break cancel()
    }
    session.resolve(null);
  }

  isActive(): boolean {
    return this.active !== null;
  }

  expiresAt(): number | null {
    return this.active?.expiresAt ?? null;
  }

  tryClaim(update: InboundTextUpdate): boolean {
    const session = this.active;
    if (!session) return false;
    if (update.chat.type !== "private") return false;
    const userId = update.from?.id;
    if (typeof userId !== "number") return false;
    if (typeof update.text !== "string" || update.text.trim().length === 0) {
      return false;
    }
    this.active = null;
    try {
      session.cancelTimer();
    } catch {
      // ignore
    }
    session.resolve({ userId, chatId: update.chat.id });
    return true;
  }
}

function defaultScheduleTimeout(cb: () => void, ms: number): () => void {
  const handle = setTimeout(cb, ms);
  // Pairing should never block process exit. `unref` is a no-op on
  // platforms / runtimes where the handle is plain numeric.
  if (typeof (handle as { unref?: () => unknown }).unref === "function") {
    (handle as { unref: () => unknown }).unref();
  }
  return () => clearTimeout(handle);
}
