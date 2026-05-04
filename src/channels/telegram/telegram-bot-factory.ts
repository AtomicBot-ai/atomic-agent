import type { InboundCallbackUpdate } from "./approval-bridge.js";
import type { InboundTextUpdate } from "./inbound-handler.js";
import type { BotFactory, BotInstance } from "./telegram-channel.js";

/**
 * Default `BotFactory` — wraps `grammy.Bot` to satisfy `BotInstance`.
 * grammy is loaded lazily via dynamic import so the (relatively
 * heavy) module graph stays out of the runtime image when the
 * channel never starts (e.g. `telegram.enabled === false`). Tests
 * inject their own factory via `TelegramChannel`'s `botFactory` dep.
 */
export const defaultGrammyBotFactory: BotFactory = async (token) => {
  const grammy = await import("grammy");
  const bot = new grammy.Bot(token);
  let textHandler: ((u: InboundTextUpdate) => void | Promise<void>) | null =
    null;
  let callbackHandler:
    | ((u: InboundCallbackUpdate) => void | Promise<void>)
    | null = null;
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
    const update = {
      ...(gctx.from ? { from: { id: gctx.from.id } } : {}),
      chat: { id: msg.chat.id, type: msg.chat.type },
      text: msg.text,
      message_id: msg.message_id,
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
  const instance: BotInstance = {
    api: bot.api as unknown as BotInstance["api"],
    setTextHandler(handler) {
      textHandler = handler;
    },
    setCallbackHandler(handler) {
      callbackHandler = handler;
    },
    start(onStart) {
      void bot.start({ onStart }).catch(() => undefined);
    },
    async stop() {
      await bot.stop();
    },
  };
  return instance;
};
