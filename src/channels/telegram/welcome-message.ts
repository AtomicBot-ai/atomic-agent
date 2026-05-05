import type { TelegramApi, TelegramLogger } from "./outbound-sender.js";
import { scrubErrorMessage } from "./telegram-channel-types.js";

/**
 * Single short DM the runtime posts to the operator the moment a
 * pairing claim has been *persisted*. Sent at most once per claim;
 * failures are logged and swallowed so a flaky `sendMessage` cannot
 * unwind the pairing transaction.
 *
 * Locked invariants (pinned by `welcome-message.test.ts`):
 *  - Best-effort. API errors are caught + warn-logged through
 *    `scrubErrorMessage` so a future grammy version that inlines the
 *    bot URL into an error can never leak the token via the warn log.
 *  - The text is a fixed plain-text string. No tokens, no error
 *    fragments, no operator-supplied input is ever interpolated.
 *  - Returns `true` when the API call resolved without throwing,
 *    `false` otherwise. Callers (TUI) use this to avoid claiming
 *    delivery in the "Owner confirmed" UI when the welcome was
 *    actually skipped or rejected.
 */
export const WELCOME_MESSAGE_TEXT = [
  "✅ Telegram connected.",
  "You can now control Atomic Agent from this chat.",
  "Send /help anytime for available commands.",
].join("\n");

export interface SendWelcomeMessageOptions {
  api: TelegramApi;
  chatId: number;
  logger?: TelegramLogger;
}

export async function sendWelcomeMessage(
  opts: SendWelcomeMessageOptions,
): Promise<boolean> {
  try {
    await opts.api.sendMessage(opts.chatId, WELCOME_MESSAGE_TEXT, {
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    opts.logger?.warn("telegram: welcome sendMessage failed (non-fatal)", {
      error: scrubErrorMessage(err),
    });
    return false;
  }
}
