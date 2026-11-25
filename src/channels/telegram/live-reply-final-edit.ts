import { callWithFloodRetry } from "./flood-retry.js";
import {
  formatChunk,
  isParseEntityError,
  parseModeSendOptions,
  stringifyError,
  type TelegramApi,
  type TelegramLogger,
  type TelegramParseMode,
} from "./outbound-sender.js";
import { isNotModified } from "./telegram-progress-indicator.js";

/** One streamed message that is about to become a final reply chunk. */
export interface FinalEditTarget {
  api: TelegramApi;
  chatId: number;
  messageId: number;
  logger?: TelegramLogger;
  sleep?: (ms: number) => Promise<void>;
  floodRetryBudgetMs?: number;
}

/**
 * Edit a streamed message into its final chunk (ATO-634): formatted with
 * the same converter and options as a sent reply, flood-waits waited out
 * and retried, and the plain chunk when Telegram rejects the formatting
 * (the same fallback `sendOutbound` makes). "Not modified" counts as done.
 * `false` means the message cannot take the chunk (deleted, too old,
 * any other error) and the caller should send it as a new message.
 */
export async function editIntoFinal(
  target: FinalEditTarget,
  raw: string,
  parseMode: TelegramParseMode,
): Promise<boolean> {
  const editMessageText = target.api.editMessageText;
  if (!editMessageText) return false;
  const edit = (text: string, extra: Record<string, unknown> | undefined) =>
    callWithFloodRetry(
      () => editMessageText.call(target.api, target.chatId, target.messageId, text, extra),
      {
        ...(target.sleep ? { sleep: target.sleep } : {}),
        ...(target.floodRetryBudgetMs !== undefined
          ? { budgetMs: target.floodRetryBudgetMs }
          : {}),
      },
    );
  try {
    await edit(formatChunk(raw, parseMode), parseModeSendOptions(parseMode));
    return true;
  } catch (err) {
    if (isNotModified(err)) return true;
    if (parseMode !== "plain" && isParseEntityError(err)) {
      target.logger?.warn("telegram: parse_mode rejected on final edit, using plain", {
        chatId: target.chatId,
        error: stringifyError(err),
      });
      try {
        await edit(raw, undefined);
        return true;
      } catch (plainErr) {
        if (isNotModified(plainErr)) return true;
      }
    }
    target.logger?.warn("telegram: final edit failed, sending as new message", {
      chatId: target.chatId,
      messageId: target.messageId,
      error: stringifyError(err),
    });
    return false;
  }
}
