import type { InboundCallbackUpdate } from "./approval-bridge.js";
import type { InboundTextUpdate } from "./inbound-handler.js";
import type { BotFactory, BotInstance } from "./telegram-channel.js";
import { scrubErrorMessage } from "./telegram-channel-types.js";
import {
  pickTelegramFile,
  type InboundFileUpdate,
  type TelegramFileMessage,
} from "./telegram-file-update.js";

/**
 * Every filter query that carries a file. Registered as one `bot.on`
 * so a message matching several (Telegram sends a GIF as both
 * `animation` and `document`) runs the handler exactly once.
 */
const FILE_FILTERS = [
  "message:photo",
  "message:animation",
  "message:video_note",
  "message:video",
  "message:voice",
  "message:audio",
  "message:sticker",
  "message:document",
] as const;

/** Bot API download endpoint; `getFile` returns the trailing `file_path`. */
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file/bot";

/**
 * Default `BotFactory` — wraps `grammy.Bot` to satisfy `BotInstance`.
 * grammy is loaded lazily via dynamic import so the (relatively
 * heavy) module graph stays out of the runtime image when the
 * channel never starts (e.g. `telegram.enabled === false`). Tests
 * inject their own factory via `TelegramChannel`'s `botFactory` dep.
 */
export const defaultGrammyBotFactory: BotFactory = async (token, hooks) => {
  const grammy = await import("grammy");
  const bot = new grammy.Bot(token);
  // grammy reports polling failures through `bot.catch`, and without a
  // handler it writes them to `console.error` — which Ink owns in the
  // TUI, so a poll loop that keeps failing looks like a healthy channel
  // that never receives anything. Route them to the caller instead.
  bot.catch((err) => {
    const cause = err instanceof Error ? err : new Error(String(err));
    hooks?.onError?.(cause);
  });
  let textHandler: ((u: InboundTextUpdate) => void | Promise<void>) | null =
    null;
  let callbackHandler:
    ((u: InboundCallbackUpdate) => void | Promise<void>) | null = null;
  let fileHandler: ((u: InboundFileUpdate) => void | Promise<void>) | null =
    null;
  // grammy's built-in `bot.start()` long-polling drains updates
  // sequentially: it `await`s every middleware before fetching the
  // next batch via `getUpdates`. Awaiting `textHandler` here would
  // therefore block `/cancel` (and every other update) for the entire
  // duration of an in-flight agent turn — `inflight[chatId]` would be
  // cleared by `dispatchToRuntime`'s finally block before `/cancel`
  // could ever observe it.
  //
  // Fire-and-forget unblocks the polling loop so cancellation reaches
  // `inflight.get(chatId)` while the previous turn is still running.
  // This is the cheap form of `@grammyjs/runner`-style concurrency,
  // sufficient for a single-operator bot. Trade-offs:
  //   - bypasses grammy's `bot.catch` pipeline (we don't use it);
  //   - update-id confirmation becomes optimistic — on a hard crash
  //     between fetch and handler completion, Telegram thinks the
  //     update was processed (acceptable for a local single-operator
  //     bot, would not be acceptable at scale).
  // `handleInboundText` already swallows every internal failure, so
  // the `.catch` below only fires on a genuine bug (defence-in-depth).
  bot.on("message:text", (gctx) => {
    const handler = textHandler;
    if (!handler) return;
    const msg = gctx.message;
    if (!msg) return;
    const title = "title" in msg.chat ? msg.chat.title : undefined;
    const replyFrom = msg.reply_to_message?.from;
    const update: InboundTextUpdate = {
      ...(gctx.from ? { from: { id: gctx.from.id } } : {}),
      chat: {
        id: msg.chat.id,
        type: msg.chat.type,
        ...(typeof title === "string" ? { title } : {}),
      },
      text: msg.text,
      message_id: msg.message_id,
      // Forum-topic routing: `is_topic_message` marks a real topic;
      // `message_thread_id` alone is also set on plain replies.
      ...(typeof msg.message_thread_id === "number"
        ? { message_thread_id: msg.message_thread_id }
        : {}),
      ...(msg.is_topic_message === true ? { is_topic_message: true } : {}),
      // Who the replied-to message came from, so "reply to the bot" can
      // count as addressing it in a group.
      ...(replyFrom
        ? {
            reply_to_message: {
              from: {
                id: replyFrom.id,
                ...(replyFrom.is_bot === true ? { is_bot: true } : {}),
              },
            },
          }
        : {}),
    };
    void Promise.resolve()
      .then(() => handler(update))
      .catch((err) => {
        process.stderr.write(
          `[telegram] textHandler rejected unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
  });
  // File-bearing messages (photo, document, voice, …) take the same
  // fire-and-forget path: a download plus an agent turn must never
  // block the polling loop. `message:text` never matches these — a
  // media message carries `caption`, not `text` — so no update is
  // dispatched twice.
  bot.on([...FILE_FILTERS], (gctx) => {
    const handler = fileHandler;
    if (!handler) return;
    const msg = gctx.message;
    if (!msg) return;
    const file = pickTelegramFile(msg as TelegramFileMessage);
    if (!file) return;
    const update: InboundFileUpdate = {
      ...(gctx.from ? { from: { id: gctx.from.id } } : {}),
      chat: { id: msg.chat.id, type: msg.chat.type },
      message_id: msg.message_id,
      ...(typeof msg.caption === "string" ? { caption: msg.caption } : {}),
      ...(typeof msg.media_group_id === "string"
        ? { media_group_id: msg.media_group_id }
        : {}),
      file,
    };
    void Promise.resolve()
      .then(() => handler(update))
      .catch((err) => {
        process.stderr.write(
          `[telegram] fileHandler rejected unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
  });
  // Same fire-and-forget pattern as `message:text` (see comment
  // above): grammy's polling loop blocks `getUpdates` while it awaits
  // any middleware, so awaiting an approval-callback handler would
  // re-introduce the same /cancel-blocking class of bug.
  bot.on("callback_query:data", (gctx) => {
    const handler = callbackHandler;
    if (!handler) return;
    const cb = gctx.callbackQuery;
    if (!cb) return;
    const update: InboundCallbackUpdate = {
      id: cb.id,
      ...(gctx.from ? { from: { id: gctx.from.id } } : {}),
      ...(cb.message
        ? {
            message: {
              chat: { id: cb.message.chat.id },
              message_id: cb.message.message_id,
            },
          }
        : {}),
      ...(cb.data ? { data: cb.data } : {}),
    };
    void Promise.resolve()
      .then(() => handler(update))
      .catch((err) => {
        process.stderr.write(
          `[telegram] callbackHandler rejected unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
  });
  // The download URL embeds the token, so the fetch lives here — the
  // only module that holds it — and never in the inbound handler.
  // Errors are scrubbed before they leave, since a failed fetch
  // routinely quotes the URL.
  const downloadFile = async (fileId: string): Promise<Uint8Array> => {
    const info = await bot.api.getFile(fileId);
    const filePath = info.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("Telegram returned no file_path for the attachment");
    }
    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_FILE_BASE}${token}/${filePath}`);
    } catch (err) {
      throw new Error(
        `Telegram file download failed: ${scrubErrorMessage(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`Telegram file download failed with HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
  // Outbound files go through grammy's `InputFile` so the adapter
  // streams the file from disk; the rest of the channel only ever
  // handles paths.
  const sendFile = async (
    chatId: number,
    file: { path: string; kind: "photo" | "document"; threadId?: number },
  ): Promise<unknown> => {
    const input = new grammy.InputFile(file.path);
    // A file answering a question asked in a forum topic belongs in
    // that topic, same as the text reply.
    const other =
      file.threadId === undefined
        ? undefined
        : { message_thread_id: file.threadId };
    return file.kind === "photo"
      ? bot.api.sendPhoto(chatId, input, other)
      : bot.api.sendDocument(chatId, input, other);
  };
  const api = bot.api as unknown as BotInstance["api"];
  Object.assign(api, { downloadFile, sendFile });
  const instance: BotInstance = {
    api,
    setTextHandler(handler) {
      textHandler = handler;
    },
    setCallbackHandler(handler) {
      callbackHandler = handler;
    },
    setFileHandler(handler) {
      fileHandler = handler;
    },
    start(onStart, onStopped) {
      // grammy's `bot.start()` promise settles when polling ends —
      // resolving on a clean stop, rejecting on a fatal error (409
      // conflict, revoked token). Swallowing it, as this did, made a
      // dead poller indistinguishable from a healthy one.
      void bot
        .start({ onStart })
        .then(() => onStopped?.())
        .catch((err: unknown) => onStopped?.(err));
    },
    async stop() {
      await bot.stop();
    },
  };
  return instance;
};
