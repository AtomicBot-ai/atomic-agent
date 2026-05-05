import type { TuiState } from "../tui-state.js";
import { isTelegramAction, type TelegramAction } from "./telegram-actions.js";
import type { TelegramPanelState } from "./telegram-panel-state.js";

/**
 * Reducer slice for `state.telegramPanel`. Returns an updated
 * `TuiState` when the action belongs to this slice, `null` otherwise
 * so the root reducer can fall through to other slices. Pure: every
 * side effect (channel calls, persistence, timers) lives in
 * `tui-telegram-orchestrator.ts`.
 */
export function reduceTelegramAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isTelegramAction(action)) return null;
  const panel = state.telegramPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, telegramPanel: next };
}

function reducePanel(
  panel: TelegramPanelState,
  action: TelegramAction,
): TelegramPanelState {
  switch (action.type) {
    case "telegram_status_changed":
      return {
        ...panel,
        channelState: action.channelState,
        lastError: action.lastError,
      };
    case "telegram_settings_synced":
      return {
        ...panel,
        enabled: action.enabled,
        ownerUserId: action.ownerUserId,
        hasToken: action.hasToken,
        ...(action.botId !== undefined ? { botId: action.botId } : {}),
        ...(action.botUsername !== undefined
          ? { botUsername: action.botUsername }
          : {}),
        // Persisted owner ⇒ the most recent pairing attempt is no
        // longer the source of truth; clear the timeout sticky.
        ...(action.ownerUserId !== null
          ? { lastDismissedPairingTimedOut: false }
          : {}),
      };
    case "telegram_action_started":
      return { ...panel, busy: true };
    case "telegram_action_settled":
      return {
        ...panel,
        busy: false,
        message: action.message ?? panel.message,
        lastError: action.error ?? panel.lastError,
      };
    case "telegram_token_prompt_opened":
      return {
        ...panel,
        mode: "tokenPrompt",
        tokenPrompt: { buffer: "", error: null, submitting: false },
      };
    case "telegram_token_prompt_buffer_changed":
      if (!panel.tokenPrompt) return panel;
      return {
        ...panel,
        tokenPrompt: {
          ...panel.tokenPrompt,
          buffer: action.buffer,
          error: null,
        },
      };
    case "telegram_token_prompt_error_set":
      if (!panel.tokenPrompt) return panel;
      return {
        ...panel,
        tokenPrompt: { ...panel.tokenPrompt, error: action.error },
      };
    case "telegram_token_prompt_submitting_started":
      if (!panel.tokenPrompt) return panel;
      return {
        ...panel,
        tokenPrompt: { ...panel.tokenPrompt, submitting: true },
      };
    case "telegram_token_prompt_closed":
      return { ...panel, mode: "list", tokenPrompt: null };
    case "telegram_pairing_started":
      return {
        ...panel,
        mode: "pairingActive",
        pairing: { expiresAt: action.expiresAt, nowMs: action.nowMs },
        // A fresh window starts with a clean slate — clear the
        // sticky "didn't complete" hint from a previous attempt.
        lastDismissedPairingTimedOut: false,
      };
    case "telegram_pairing_tick":
      if (!panel.pairing) return panel;
      return {
        ...panel,
        pairing: { ...panel.pairing, nowMs: action.nowMs },
      };
    case "telegram_pairing_resolved":
      if (action.result) {
        return {
          ...panel,
          mode: "pairingResult",
          pairing: null,
          pairingResult: { ...action.result },
          ownerUserId: action.result.userId,
          lastDismissedPairingTimedOut: false,
        };
      }
      return {
        ...panel,
        mode: "list",
        pairing: null,
        pairingResult: null,
        // Surface the failure to the setup view; the advanced bar
        // already shows `lastError`. Avoid duplicating into `message`
        // because the setup view owns the user-facing copy.
        lastDismissedPairingTimedOut: true,
      };
    case "telegram_pairing_modal_dismissed":
      return {
        ...panel,
        mode: "list",
        pairing: null,
        pairingResult: null,
      };
    case "telegram_message_cleared":
      return { ...panel, message: null };
    case "telegram_advanced_toggled":
      return { ...panel, showAdvanced: !panel.showAdvanced };
    default:
      return panel;
  }
}
