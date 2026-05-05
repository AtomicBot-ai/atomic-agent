import type { ChannelState } from "../../runtime/channel-status.js";

/**
 * Reducer actions specific to the Telegram tab. Orchestrator and
 * keyboard layers emit these; the reducer folds them into
 * `state.telegramPanel`. The `telegram_*` prefix lets the root
 * reducer narrow without a runtime tag dictionary.
 *
 * No action carries the bot token in plaintext — the closest is
 * `telegram_token_prompt_buffer_changed`, which only flows inside the
 * modal's masked-input loop and is dropped when the modal closes.
 */
export type TelegramAction =
  | {
      type: "telegram_status_changed";
      channelState: ChannelState;
      lastError: string | null;
    }
  | {
      type: "telegram_settings_synced";
      enabled: boolean;
      ownerUserId: number | null;
      hasToken: boolean;
      botId?: number | null;
      botUsername?: string | null;
    }
  | { type: "telegram_action_started" }
  | { type: "telegram_action_settled"; message?: string; error?: string }
  | { type: "telegram_token_prompt_opened" }
  | { type: "telegram_token_prompt_buffer_changed"; buffer: string }
  | { type: "telegram_token_prompt_error_set"; error: string | null }
  | { type: "telegram_token_prompt_submitting_started" }
  | { type: "telegram_token_prompt_closed" }
  | {
      type: "telegram_pairing_started";
      expiresAt: number;
      nowMs: number;
    }
  | { type: "telegram_pairing_tick"; nowMs: number }
  | {
      type: "telegram_pairing_resolved";
      result: {
        userId: number;
        chatId: number;
        /**
         * Whether the post-persistence welcome DM actually reached
         * Telegram. The reducer stores this on `pairingResult` so the
         * "Owner confirmed" card branches between "Welcome message
         * sent" and "DM the bot once to verify".
         */
        welcomeDelivered: boolean;
      } | null;
    }
  | { type: "telegram_pairing_modal_dismissed" }
  | { type: "telegram_message_cleared" }
  | { type: "telegram_advanced_toggled" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isTelegramAction(action: {
  type: string;
}): action is TelegramAction {
  return action.type.startsWith("telegram_");
}
