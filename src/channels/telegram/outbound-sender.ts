import { convertMarkdownToTelegramHtml } from "./markdown-to-html.js";

/**
 * Telegram parse-mode variants we support on agent-driven outbound
 * messages. `plain` is the legacy behaviour (no parse_mode header,
 * raw text); `html` converts the source text from markdown into
 * Telegram's HTML subset and sends with `parse_mode: "HTML"`. The
 * MarkdownV2 path is intentionally absent — see AGENTS.md
 * §"Telegram remote-control channel" for the rationale.
 */
export type TelegramParseMode = "plain" | "html";

/**
 * Narrow surface of `bot.api` consumed by the Telegram outbound and
 * inbound paths. Defining a structural shape here lets tests inject a
 * fake instead of pulling the full grammy type tree, and the channel
 * orchestrator (`telegram-channel.ts`) wraps the real `Bot` to satisfy
 * it.
 */
export interface TelegramApi {
  sendMessage(
    chatId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number } | unknown>;
  sendChatAction?(
    chatId: number,
    action: "typing",
  ): Promise<unknown>;
  editMessageText?(
    chatId: number,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Acknowledge a `callback_query` so the in-app loading spinner on
   * the operator's client dismisses. Optional because the inbound
   * paths that don't process callback queries never call it.
   */
  answerCallbackQuery?(
    callbackQueryId: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface TelegramLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface OutboundSendOptions {
  api: TelegramApi;
  chatId: number;
  text: string;
  logger?: TelegramLogger;
  /** Test seam — replaces `setTimeout` in the 429 retry path. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Render mode for the outbound text. Defaults to `"plain"` (legacy
   * behaviour, no parse_mode header). When `"html"`, each chunk is
   * converted from markdown via `convertMarkdownToTelegramHtml` and
   * sent with `parse_mode: "HTML"`. On HTTP 400 ("can't parse
   * entities") we transparently retry the same chunk as plain text
   * so a formatter bug never silently swallows the operator's
   * reply. See AGENTS.md §"Telegram remote-control channel".
   */
  parseMode?: TelegramParseMode;
}

export interface OutboundSendResult {
  chunks: number;
  dropped: number;
  /**
   * How many chunks were demoted from formatted (e.g. HTML) to plain
   * text after Telegram rejected the formatted body with HTTP 400.
   * `0` in plain-mode and in the happy-path. Surfaced for metrics
   * and so tests can pin the fallback contract.
   */
  parseFallbacks: number;
}

/**
 * Telegram limits a single `sendMessage` to 4096 UTF-16 units. We
 * pick 4000 to leave headroom for the prefix the caller may add (e.g.
 * `[step 12] ` if a future feature introduces inline annotations).
 */
const CHUNK_SIZE_CHARS = 4000;

/**
 * Hard ceiling on the `retry_after` we honour. A bot that has been
 * hammered hard enough to receive a >30 s back-off should drop the
 * chunk and surface a warning rather than block the loop for minutes.
 */
const RETRY_AFTER_MAX_SECONDS = 30;

/**
 * Send `text` to `chatId`, chunking across multiple `sendMessage` calls
 * when needed. On HTTP 429 honour `retry_after` once; if the retry also
 * 429s, drop the chunk with a warn-level log and continue with the
 * next one. On HTTP 400 in formatted mode (`parseMode: "html"`),
 * retry the same chunk once as plain text — see AGENTS.md
 * §"Telegram remote-control channel" for the invariant. Errors that
 * are neither 429 nor a parse-related 400 are logged and skipped —
 * the goal is "best-effort delivery of as many chunks as possible"
 * rather than "all-or-nothing".
 *
 * Chunking always operates on the raw input text (line-break aware),
 * and the parse-mode conversion runs *per chunk*. This means a stray
 * unbalanced markdown delimiter that straddles a chunk boundary
 * degrades to literal text in both halves rather than producing a
 * corrupt HTML tag — robustness over fidelity for the rare edge
 * case.
 */
export async function sendOutbound(
  opts: OutboundSendOptions,
): Promise<OutboundSendResult> {
  const chunks = chunkUtf16(opts.text, CHUNK_SIZE_CHARS);
  const parseMode = opts.parseMode ?? "plain";
  let dropped = 0;
  let parseFallbacks = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const rawChunk = chunks[i]!;
    const formatted = formatChunk(rawChunk, parseMode);
    const sendOpts = parseModeSendOptions(parseMode);
    try {
      await opts.api.sendMessage(opts.chatId, formatted, sendOpts);
    } catch (err) {
      const retryAfter = readRetryAfterSeconds(err);
      if (retryAfter !== null) {
        const sleep = opts.sleep ?? defaultSleep;
        await sleep(retryAfter * 1000);
        try {
          await opts.api.sendMessage(opts.chatId, formatted, sendOpts);
        } catch (secondErr) {
          dropped += 1;
          opts.logger?.warn("telegram: dropping chunk after second 429", {
            chatId: opts.chatId,
            chunkIndex: i,
            error: stringifyError(secondErr),
          });
        }
        continue;
      }
      if (parseMode !== "plain" && isParseEntityError(err)) {
        // Telegram could not parse our formatted body. Retry the same
        // logical chunk as plain text so the operator never loses the
        // reply because of an escape miss. Counted separately so
        // metrics + tests can detect formatter regressions.
        parseFallbacks += 1;
        opts.logger?.warn("telegram: parse_mode rejected, retrying as plain", {
          chatId: opts.chatId,
          chunkIndex: i,
          parseMode,
          error: stringifyError(err),
        });
        try {
          await opts.api.sendMessage(opts.chatId, rawChunk);
        } catch (secondErr) {
          dropped += 1;
          opts.logger?.warn("telegram: plain-text fallback also failed", {
            chatId: opts.chatId,
            chunkIndex: i,
            error: stringifyError(secondErr),
          });
        }
        continue;
      }
      dropped += 1;
      opts.logger?.warn("telegram: failed to send chunk", {
        chatId: opts.chatId,
        chunkIndex: i,
        error: stringifyError(err),
      });
    }
  }
  return { chunks: chunks.length, dropped, parseFallbacks };
}

function formatChunk(raw: string, parseMode: TelegramParseMode): string {
  if (parseMode === "html") return convertMarkdownToTelegramHtml(raw);
  return raw;
}

function parseModeSendOptions(
  parseMode: TelegramParseMode,
): Record<string, unknown> | undefined {
  if (parseMode === "html") {
    // `disable_web_page_preview` keeps a stray bare URL inside the
    // agent's reply from triggering an unwanted card preview that
    // would clutter the operator's chat with link-unfurled metadata.
    return { parse_mode: "HTML", disable_web_page_preview: true };
  }
  return undefined;
}

/**
 * Detect Telegram's "can't parse entities" error shape. The library
 * surfaces the bot-API error as `{ error_code: 400, description?: "Bad
 * Request: can't parse entities..." }`; raw fetch errors from a
 * future transport replacement may also surface as `{ status: 400 }`.
 * We accept both.
 */
function isParseEntityError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    error_code?: unknown;
    status?: unknown;
    description?: unknown;
    message?: unknown;
  };
  const is400 = e.error_code === 400 || e.status === 400;
  if (!is400) return false;
  const text = `${typeof e.description === "string" ? e.description : ""} ${
    typeof e.message === "string" ? e.message : ""
  }`.toLowerCase();
  // Match the canonical bot-API string and the looser "entities" /
  // "tag" wording in case Telegram tweaks the description text.
  return (
    text.includes("can't parse entities") ||
    text.includes("can't find end of") ||
    text.includes("parse entities") ||
    text.includes("unsupported start tag") ||
    text.includes("entities")
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readRetryAfterSeconds(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    error_code?: unknown;
    parameters?: { retry_after?: unknown } | undefined;
  };
  if (e.error_code !== 429) return null;
  const value = e.parameters?.retry_after;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(value, RETRY_AFTER_MAX_SECONDS);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Split `text` into chunks of at most `limit` UTF-16 units, never
 * splitting a JS surrogate pair. Prefer breaking at the most recent
 * `\n` in the buffer when one exists in the second half — keeps
 * paragraphs intact for the operator. Empty input yields `[]`.
 */
export function chunkUtf16(text: string, limit: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (buf.length + ch.length > limit) {
      const breakAt = preferLineBreak(buf, limit);
      if (breakAt > 0) {
        chunks.push(buf.slice(0, breakAt));
        buf = buf.slice(breakAt);
      } else {
        chunks.push(buf);
        buf = "";
      }
    }
    buf += ch;
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

function preferLineBreak(buf: string, limit: number): number {
  if (buf.length < Math.floor(limit / 2)) return -1;
  const idx = buf.lastIndexOf("\n");
  return idx > 0 ? idx + 1 : -1;
}
