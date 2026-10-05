import type { Transformer } from "grammy";

import type { InboundCallbackUpdate } from "./approval-bridge.js";
import type { InboundTextUpdate } from "./inbound-handler.js";
import type { BotFactory, BotInstance } from "./telegram-channel.js";
import {
  scrubErrorMessage,
  type BotFactoryHooks,
} from "./telegram-channel-types.js";
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
/** Bot downloads are capped at 20 MB; past this the transfer is stuck. */
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * How long a `getUpdates` may run past its own long-poll `timeout`
 * before it is given up on. Telegram answers an empty long poll at the
 * timeout to the second; a request still open well after that is on a
 * connection that died without a FIN (sleep, a Wi-Fi switch, a NAT that
 * dropped the flow). Without this it inherited grammy's 500 s client
 * timeout, and the channel sat `up` for eight minutes receiving nothing.
 */
export const GET_UPDATES_GRACE_MS = 15_000;

/** The parts of a Bot API answer the poll-health transformer reads. */
interface PollAnswer {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}

/** The abort-signal surface grammy hands a transformer. */
interface PollSignal {
  aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Highest `update_id` in a `getUpdates` result, `null` when empty. */
function highestUpdateId(result: unknown): number | null {
  if (!Array.isArray(result)) return null;
  let highest: number | null = null;
  for (const update of result as Array<{ update_id?: unknown }>) {
    const id = update?.update_id;
    if (typeof id === "number" && (highest === null || id > highest)) {
      highest = id;
    }
  }
  return highest;
}

/**
 * Wrap every `getUpdates` grammy sends -- its polling loop's and
 * `stop()`'s closing one -- with a deadline, a resume offset, and a
 * report to the channel of how it went. grammy retries a failed poll
 * every 3 s inside its loop and tells only its debug logger, so this is
 * the one place the channel can learn the connection is gone.
 *
 * Every other method passes through untouched: a deadline here would
 * also cut a large `sendDocument`.
 */
function pollHealth(
  hooks: BotFactoryHooks | undefined,
  retired: AbortSignal,
): Transformer {
  return async (prev, method, payload, signal) => {
    if (method !== "getUpdates") return prev(method, payload, signal);
    if (retired.aborted) throw new Error("telegram poller was abandoned");
    const poll = payload as unknown as { offset?: number; timeout?: number };
    const resumeAfter = hooks?.resumeAfterUpdateId?.() ?? null;
    const outgoing =
      resumeAfter !== null && (poll.offset ?? 0) <= resumeAfter
        ? { ...poll, offset: resumeAfter + 1 }
        : poll;
    const deadlineMs = (poll.timeout ?? 0) * 1000 + GET_UPDATES_GRACE_MS;
    const outer = signal as unknown as PollSignal | undefined;
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    const deadline = setTimeout(() => {
      timedOut = true;
      abort();
    }, deadlineMs);
    // A poll waiting on its deadline must never hold a process open.
    deadline.unref?.();
    outer?.addEventListener("abort", abort);
    retired.addEventListener("abort", abort);
    if (outer?.aborted) abort();
    try {
      const res = await prev(
        method,
        outgoing as unknown as typeof payload,
        controller.signal as unknown as typeof signal,
      );
      const answer = res as unknown as PollAnswer;
      if (answer.ok) {
        hooks?.onPollAnswered?.(highestUpdateId(answer.result));
      } else if ((answer.error_code ?? 0) >= 500) {
        hooks?.onPollFailed?.(
          new Error(
            `getUpdates failed (${answer.error_code}: ${answer.description ?? "no description"})`,
          ),
        );
      } else {
        // 401 and 409 grammy rethrows, ending its loop -- the channel
        // hears of those through `onStopped`. A 429 is Telegram answering
        // with a `retry_after` grammy honours. Either way the line is up.
        hooks?.onPollAnswered?.(null);
      }
      return res;
    } catch (err) {
      // A stop or an abandon cancels the poll on purpose; neither says
      // anything about the connection.
      if (!outer?.aborted && !retired.aborted) {
        hooks?.onPollFailed?.(
          timedOut
            ? new Error(
                `getUpdates got no answer within ${Math.round(deadlineMs / 1000)}s`,
              )
            : err instanceof Error
              ? err
              : new Error(String(err)),
        );
      }
      throw err;
    } finally {
      clearTimeout(deadline);
      outer?.removeEventListener("abort", abort);
      retired.removeEventListener("abort", abort);
    }
  };
}

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
  // Aborted by `abandon()`: cancels the polls in flight and refuses the
  // rest, `stop()`'s closing confirmation included.
  const retired = new AbortController();
  bot.api.config.use(pollHealth(hooks, retired.signal));
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
      // The name fields feed the `[from]` identity line in a group.
      // Copied field by field (rather than spreading `gctx.from`) so
      // nothing else from the platform payload can drift into the
      // prompt unnoticed.
      ...(gctx.from
        ? {
            from: {
              id: gctx.from.id,
              ...(typeof gctx.from.first_name === "string"
                ? { first_name: gctx.from.first_name }
                : {}),
              ...(typeof gctx.from.last_name === "string"
                ? { last_name: gctx.from.last_name }
                : {}),
              ...(typeof gctx.from.username === "string"
                ? { username: gctx.from.username }
                : {}),
            },
          }
        : {}),
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
      res = await fetch(`${TELEGRAM_FILE_BASE}${token}/${filePath}`, {
        // Telegram caps a bot download at 20 MB, so a transfer that has
        // not finished in this long is not going to. Without a clock of
        // its own this inherited the transport's, which is no longer
        // five minutes — see `installTransportDeadlines`.
        signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
      });
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
    abandon() {
      retired.abort();
      // Ends grammy's loop; its closing `getUpdates` now fails at once.
      void bot.stop().catch(() => undefined);
    },
  };
  return instance;
};
