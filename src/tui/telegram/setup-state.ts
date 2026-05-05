import type { TelegramPanelState } from "./telegram-panel-state.js";

/**
 * High-level "where the operator is in the connect flow" enum,
 * derived from the flat `TelegramPanelState` mirrors. Pure projection
 * — no new fields in the reducer — so the setup view and the existing
 * advanced controls stay strictly synchronised on the same source of
 * truth.
 *
 * Locked invariants (pinned by `setup-state.test.ts`):
 *  - `ready` is the **only** step that requires *all three* runtime
 *    facts: token present, channel `up`, owner persisted. Anything
 *    less collapses into the appropriate setup step.
 *  - `pairing_active` strictly tracks `mode === "pairingActive"`; it
 *    is the only step that depends on UI mode. Every other step is
 *    derivable from runtime state alone.
 *  - The function never reads `tokenPrompt.buffer`. The bot token is
 *    not part of the setup taxonomy — only `hasToken` (boolean).
 */
export type SetupStep =
  | "not_connected"
  | "connecting"
  | "needs_pairing"
  | "pairing_active"
  | "pairing_failed"
  | "ready";

export interface SetupView {
  step: SetupStep;
  /** Plain-language headline for the panel CTA. */
  title: string;
  /** Short body line under the title. Plain text, never includes secrets. */
  body: string;
  /** Optional hint about what pressing Enter will do right now. */
  cta: string | null;
  /** True when the panel should expose advanced controls inline. */
  isTerminal: boolean;
}

export function deriveSetupState(panel: TelegramPanelState): SetupView {
  if (panel.mode === "pairingActive") {
    return {
      step: "pairing_active",
      title: "Open Telegram and DM your bot",
      body: "Send any text from the account you want to register as the owner. Group / channel messages are ignored.",
      cta: "Esc to cancel",
      isTerminal: false,
    };
  }

  if (!panel.hasToken) {
    return {
      step: "not_connected",
      title: "Connect Telegram",
      body: "Create a bot with @BotFather, copy the token, and paste it here. The token is stored only on this machine.",
      cta: "Press Enter to paste a bot token",
      isTerminal: false,
    };
  }

  // `starting` is the normal warm-up; `stopping` and the brief
  // `disabled` window only show up during `setOwnerUserId`'s
  // restart cycle (stop → disabled → starting → up). Treating them
  // as `connecting` hides the sub-second flicker where the channel
  // is technically `disabled` but we already have a fresh owner
  // pending — the alternative is the panel briefly claiming `ready`
  // before the bot is back up.
  const inRestartTransient =
    panel.channelState === "stopping" ||
    (panel.channelState === "disabled" &&
      panel.enabled &&
      panel.hasToken);
  if (panel.channelState === "starting" || panel.busy || inRestartTransient) {
    return {
      step: "connecting",
      title: "Connecting to Telegram…",
      body: "Validating the bot token with Telegram.",
      cta: null,
      isTerminal: false,
    };
  }

  if (panel.channelState === "down") {
    return {
      step: "not_connected",
      title: "Telegram is not connected",
      body:
        panel.lastError ??
        "The bot token was rejected or Telegram is unreachable.",
      cta: "Press Enter to try again",
      isTerminal: false,
    };
  }

  if (panel.ownerUserId === null) {
    if (panel.lastDismissedPairingTimedOut) {
      return {
        step: "pairing_failed",
        title: "Pairing didn't complete",
        body: "Nobody DMed the bot in time, so we can't confirm who owns this assistant.",
        cta: "Press Enter to open another pairing window",
        isTerminal: false,
      };
    }
    return {
      step: "needs_pairing",
      title: "One last step — confirm it's you",
      body: "Open Telegram, DM your bot any message. Atomic Agent will recognise you as the owner.",
      cta: "Press Enter to open the pairing window",
      isTerminal: false,
    };
  }

  return {
    step: "ready",
    title: panel.botUsername
      ? `✅ Telegram is connected as @${panel.botUsername}`
      : "✅ Telegram is connected",
    body: "Send a message to the bot to control Atomic Agent. Use /help inside Telegram for available commands.",
    cta: null,
    isTerminal: true,
  };
}
