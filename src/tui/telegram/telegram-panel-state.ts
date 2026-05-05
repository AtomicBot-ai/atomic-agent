import type { ChannelState } from "../../runtime/channel-status.js";

/**
 * UI state for the TUI "Telegram" tab. Separate from the
 * `TelegramChannel` runtime state — the orchestrator pushes channel
 * status into here through actions, and the reducer folds them into
 * a stable, render-friendly snapshot.
 *
 * Modes:
 *  - `list`         — default surface: status rows + action hints.
 *  - `tokenPrompt`  — modal for entering a new bot token (no echo).
 *  - `pairingActive`— modal showing the 60s pairing countdown.
 *  - `pairingResult`— modal showing the claimed owner before auto-close.
 */
export type TelegramPanelMode =
  | "list"
  | "tokenPrompt"
  | "pairingActive"
  | "pairingResult";

/**
 * Buffered state for the masked token-entry modal. The buffer is
 * never rendered as plaintext; only a fixed-width `•` placeholder
 * row is shown to the operator. The reducer keeps the buffer in
 * memory exclusively — there is no debug logging path that touches
 * `buffer`.
 */
export interface TelegramTokenPromptState {
  /** Raw characters the operator typed. Never rendered, never logged. */
  buffer: string;
  /** Inline error displayed under the masked field (e.g. "token is empty"). */
  error: string | null;
  /** True while the orchestrator is awaiting `channel.setToken`. */
  submitting: boolean;
}

export interface TelegramPairingState {
  /** Epoch ms when the active window expires. */
  expiresAt: number;
  /**
   * Last `Date.now()` observed by the orchestrator's countdown
   * ticker. Stored in state purely to drive re-renders — the
   * reducer never derives logic from it.
   */
  nowMs: number;
}

export interface TelegramPairingClaimedState {
  /** Numeric Telegram user id confirmed as the new owner. */
  userId: number;
  /** DM chat id used to persist the new owner. */
  chatId: number;
  /**
   * Whether the post-persistence welcome DM actually reached
   * Telegram. `false` when the channel restart between persistence
   * and welcome dropped the bot, or when sendMessage was rejected.
   * The success card uses this to avoid claiming delivery the runtime
   * cannot verify.
   */
  welcomeDelivered: boolean;
}

/**
 * Root state slice for the Telegram tab. Mirrors the relevant subset
 * of `TelegramChannel` state plus a few UI-only flags. The
 * orchestrator owns push updates; the reducer folds them.
 */
export interface TelegramPanelState {
  /** Latest channel state observed via `onChannelStatus`. */
  channelState: ChannelState;
  /** Sticky `lastError` from the most recent failure transition. */
  lastError: string | null;
  /** Persisted `telegram.enabled` mirror. */
  enabled: boolean;
  /** Persisted `telegram.ownerUserId` mirror; `null` when unpaired. */
  ownerUserId: number | null;
  /**
   * Whether `process.env.TELEGRAM_BOT_TOKEN` is currently populated.
   * Boolean only — the actual token is never copied into UI state.
   */
  hasToken: boolean;
  /** Optional bot username from `getMe`, surfaced for operator confirmation. */
  botUsername: string | null;
  /** Optional bot id from `getMe`. */
  botId: number | null;
  /** Active modal mode. `list` is the resting state. */
  mode: TelegramPanelMode;
  /** Token-prompt buffer + status when `mode === "tokenPrompt"`. */
  tokenPrompt: TelegramTokenPromptState | null;
  /** Active pairing window when `mode === "pairingActive"`. */
  pairing: TelegramPairingState | null;
  /** Claim shown to the operator when `mode === "pairingResult"`. */
  pairingResult: TelegramPairingClaimedState | null;
  /** Latest `nowMs` snapshot for the countdown — see `TelegramPairingState`. */
  /** Sticky one-line message (e.g. "owner saved", "token cleared"). */
  message: string | null;
  /** True while a setEnabled / setToken / setOwnerUserId call is in flight. */
  busy: boolean;
  /**
   * True when the panel should reveal the advanced hotkey grid inline
   * (toggle/restart/clear-token/clear-owner). The first-run setup view
   * intentionally hides these — they stay one keystroke away (`a`).
   */
  showAdvanced: boolean;
  /**
   * Sticky flag set when the most recent pairing window resolved to
   * `null` (timeout / cancel) instead of a claim. Cleared on the next
   * pairing start or when the owner is set by any other path. Drives
   * the "Pairing didn't complete" headline in the setup view.
   */
  lastDismissedPairingTimedOut: boolean;
}

export function createInitialTelegramPanelState(): TelegramPanelState {
  return {
    channelState: "disabled",
    lastError: null,
    enabled: false,
    ownerUserId: null,
    hasToken: false,
    botUsername: null,
    botId: null,
    mode: "list",
    tokenPrompt: null,
    pairing: null,
    pairingResult: null,
    message: null,
    busy: false,
    showAdvanced: false,
    lastDismissedPairingTimedOut: false,
  };
}
