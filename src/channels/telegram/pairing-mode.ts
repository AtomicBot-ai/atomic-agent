import { randomInt } from "node:crypto";

import type { InboundTextUpdate } from "./inbound-handler.js";

/**
 * Default pairing window (ATO-718): long enough to open Telegram, find
 * the bot and type the code, short enough that a code read off a screen
 * goes stale quickly.
 */
export const DEFAULT_PAIRING_TIMEOUT_MS = 5 * 60_000;

/** Digits in the one-time pairing code. */
export const PAIRING_CODE_DIGITS = 6;

/**
 * The only message that claims a pairing window: `/start 123456`
 * (`/start@your_bot 123456` too, which is what Telegram sends from a
 * deep link or a group-style command). Anything else in a DM is not a
 * claim, so a stranger who finds the bot first cannot become its owner
 * just by writing to it.
 */
const START_WITH_CODE = new RegExp(
  `^/start(?:@[A-Za-z0-9_]+)?\\s+(\\d{${PAIRING_CODE_DIGITS}})$`,
);

/** A fresh one-time code: uniform over all 6-digit strings, from the CSPRNG. */
export function generatePairingCode(): string {
  return String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(
    PAIRING_CODE_DIGITS,
    "0",
  );
}

/** The code in a `/start <code>` message, or `null` when the text is not one. */
export function pairingCodeIn(text: string): string | null {
  return START_WITH_CODE.exec(text.trim())?.[1] ?? null;
}

export interface ClaimedPairing {
  /** Telegram numeric user id of the claimer — written to `telegram.ownerUserId`. */
  userId: number;
  /** DM chat id used to ack the new owner. */
  chatId: number;
  /**
   * The claimer's Telegram @username (without `@`), shown to the
   * operator after pairing so they can see who became the owner.
   * `null` when the account has none.
   */
  username: string | null;
}

/**
 * What `tryClaim` did with an update: `claimed` (the right code, the
 * window is closed), `wrong_code` (a `/start <digits>` that did not
 * match: swallowed, the window stays open), `ignored` (no window, or
 * not a pairing message at all).
 */
export type PairingClaimResult = "claimed" | "wrong_code" | "ignored";

export interface PairingMode {
  /**
   * Open a pairing window with a fresh one-time code (`currentCode()`).
   * The returned promise resolves with the claimer when a private DM
   * `/start <code>` arrives, or `null` when the window times out or is
   * cancelled. Calling
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
   * The active window's one-time code, for the operator's screen only.
   * `null` when inactive. Never log it.
   */
  currentCode(): string | null;
  /**
   * Hook for the inbound handler. `claimed` and `wrong_code` both mean
   * the update was consumed by pairing and must not be dispatched to
   * the agent loop. Eligibility: private chat, `from.id` present, text
   * exactly `/start <code>`.
   */
  tryClaim(update: InboundTextUpdate): PairingClaimResult;
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
  /** Test seam — overrides the one-time code generator. */
  generateCode?: () => string;
}

interface ActiveSession {
  resolve: (result: ClaimedPairing | null) => void;
  expiresAt: number;
  code: string;
  cancelTimer: () => void;
}

/**
 * Pairing-mode state machine for the Telegram channel.
 *
 * The channel calls `start()` on operator request (TUI button, CLI
 * `pair` command). Each window gets a fresh 6-digit one-time code that
 * the operator sees on their own screen; the first private DM within
 * the window that says exactly `/start <code>` is captured as the new
 * owner. Anything else (another DM, a group message, a wrong code) is
 * not a claim (ATO-718: before this, the first DM of any kind won).
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
  private readonly scheduleTimeout: (cb: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly generateCode: () => string;

  constructor(opts: PairingModeOptions = {}) {
    this.scheduleTimeout = opts.scheduleTimeout ?? defaultScheduleTimeout;
    this.now = opts.now ?? Date.now;
    this.generateCode = opts.generateCode ?? generatePairingCode;
  }

  start(
    timeoutMs: number = DEFAULT_PAIRING_TIMEOUT_MS,
  ): Promise<ClaimedPairing | null> {
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
      this.active = { resolve, expiresAt, code: this.generateCode(), cancelTimer };
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

  currentCode(): string | null {
    return this.active?.code ?? null;
  }

  tryClaim(update: InboundTextUpdate): PairingClaimResult {
    const session = this.active;
    if (!session) return "ignored";
    if (update.chat.type !== "private") return "ignored";
    const userId = update.from?.id;
    if (typeof userId !== "number") return "ignored";
    if (typeof update.text !== "string") return "ignored";
    const code = pairingCodeIn(update.text);
    if (code === null) return "ignored";
    if (code !== session.code) return "wrong_code";
    this.active = null;
    try {
      session.cancelTimer();
    } catch {
      // ignore
    }
    const username = update.from?.username?.trim();
    session.resolve({
      userId,
      chatId: update.chat.id,
      username: username ? username : null,
    });
    return "claimed";
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
