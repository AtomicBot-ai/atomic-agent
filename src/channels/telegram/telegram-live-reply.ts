import type { AgentLoopEvent } from "../../agent/agent-contract.js";

import { floodWaitSeconds } from "./flood-retry.js";
import { editIntoFinal, type FinalEditTarget } from "./live-reply-final-edit.js";
import {
  chunkUtf16,
  sendOutbound,
  stringifyError,
  TELEGRAM_CHUNK_CHARS,
  withThread,
  type TelegramApi,
  type TelegramLogger,
  type TelegramParseMode,
} from "./outbound-sender.js";
import { isNotModified } from "./telegram-progress-indicator.js";

/** Telegram's practical per-chat pace: about one message or edit a second. */
export const LIVE_REPLY_MIN_EDIT_INTERVAL_MS = 1000;
/** An edit for fewer new characters than this waits for the trailing flush. */
export const LIVE_REPLY_MIN_GROWTH_CHARS = 40;

export interface LiveReplyOptions {
  api: TelegramApi;
  chatId: number;
  /** Forum topic, so the bubbles land in the topic that asked. */
  threadId?: number;
  logger?: TelegramLogger;
  minEditIntervalMs?: number;
  minGrowthChars?: number;
  /** Characters per bubble; the final pass always uses the outbound chunk size. */
  bubbleChars?: number;
  /** Test seams. */
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
  floodRetryBudgetMs?: number;
}

export interface LiveReplyFinal {
  /** `false`: nothing was streamed, the caller sends the reply itself. */
  delivered: boolean;
  /** Messages that now carry the reply (edited or sent). */
  messages: number;
}

interface Bubble {
  id: number;
  shown: string;
}

/**
 * The agent's reply, streamed into Telegram while the model writes it
 * (ATO-634). Text deltas (`assistant_delta`) grow a plain-text message
 * that is posted once and then edited, at most once per
 * `minEditIntervalMs` and only after `minGrowthChars` new characters (a
 * trailing flush catches the tail). Past one bubble's size the bubble
 * keeps its piece and a new one starts. A new step or a parse retry
 * restarts the text (that step's earlier output was not the answer).
 *
 * `finalize` swaps every bubble for the formatted reply (the same
 * markdown-to-HTML path and chunking the normal reply uses), posts any
 * extra chunks and deletes bubbles the final text no longer needs.
 * A 429 while streaming pauses edits for `retry_after` (the next edit
 * carries all text, so nothing is lost); in `finalize` every call waits
 * and retries (`flood-retry.ts`).
 *
 * Network calls run one at a time on an internal chain; none of them
 * ever throws into the turn.
 */
export class TelegramLiveReply {
  private text = "";
  private bubbles: Bubble[] = [];
  private renderedLength = 0;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private mutedUntil = 0;
  private cancelTimer: (() => void) | null = null;
  private closed = false;
  private broken = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly minEditIntervalMs: number;
  private readonly minGrowthChars: number;
  private readonly bubbleChars: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => () => void;

  constructor(private readonly opts: LiveReplyOptions) {
    this.minEditIntervalMs = opts.minEditIntervalMs ?? LIVE_REPLY_MIN_EDIT_INTERVAL_MS;
    this.minGrowthChars = opts.minGrowthChars ?? LIVE_REPLY_MIN_GROWTH_CHARS;
    this.bubbleChars = opts.bubbleChars ?? TELEGRAM_CHUNK_CHARS;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? scheduleUnrefTimeout;
  }

  /** Streaming needs edits; an api without them keeps the old path. */
  static supported(api: TelegramApi): boolean {
    return typeof api.editMessageText === "function";
  }

  /** Feed one loop event. Ignores everything but deltas and restarts. */
  onEvent(event: AgentLoopEvent): void {
    if (this.closed) return;
    if (event.type === "step_started") return this.restart();
    if (event.type !== "llm_event") return;
    const inner = event.event;
    if (inner.type === "parse_retry") return this.restart();
    if (inner.type === "assistant_delta") this.append(inner.text);
  }

  /** Ids of the posted bubbles, oldest first. Test and logging aid. */
  messageIds(): number[] {
    return this.bubbles.map((b) => b.id);
  }

  /**
   * Replace the streamed text with the final reply. Resolves once every
   * edit, send and delete settled.
   */
  async finalize(reply: string, parseMode: TelegramParseMode): Promise<LiveReplyFinal> {
    await this.close();
    if (this.bubbles.length === 0) return { delivered: false, messages: 0 };
    const chunks = chunkUtf16(reply, TELEGRAM_CHUNK_CHARS);
    let messages = 0;
    let fresh = false;
    for (let i = 0; i < chunks.length; i += 1) {
      const raw = chunks[i]!;
      const bubble = this.bubbles[i];
      if (!fresh && bubble && (await editIntoFinal(this.finalEdit(bubble.id), raw, parseMode))) {
        messages += 1;
        continue;
      }
      // An edit failed (bubble deleted, too old) or there are more chunks
      // than bubbles: send the rest as new messages, after removing the
      // stale bubbles from here on so the reply still reads in order.
      if (!fresh) {
        fresh = true;
        await this.deleteBubbles(i);
      }
      const sent = await sendOutbound({
        api: this.opts.api,
        chatId: this.opts.chatId,
        text: raw,
        parseMode,
        ...(this.opts.threadId === undefined ? {} : { threadId: this.opts.threadId }),
        ...(this.opts.logger ? { logger: this.opts.logger } : {}),
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
        ...(this.opts.floodRetryBudgetMs !== undefined
          ? { floodRetryBudgetMs: this.opts.floodRetryBudgetMs }
          : {}),
      });
      messages += sent.chunks - sent.dropped;
    }
    if (!fresh) await this.deleteBubbles(chunks.length);
    return { delivered: true, messages };
  }

  /**
   * Stop streaming and delete what was posted (a cancelled turn: the
   * half-written answer goes, the "Turn cancelled." line says why).
   */
  async discard(): Promise<void> {
    await this.close();
    await this.deleteBubbles(0);
  }

  /** Stop streaming and leave what was posted as it is (a failed turn). */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.chain.catch(() => undefined);
  }

  private restart(): void {
    this.text = "";
    this.renderedLength = 0;
  }

  private append(delta: string): void {
    if (delta.length === 0) return;
    this.text += delta;
    this.maybeFlush(false);
  }

  private maybeFlush(trailing: boolean): void {
    if (this.closed || this.broken) return;
    const growth = this.text.length - this.renderedLength;
    if (growth <= 0 || this.text.trim().length === 0) return;
    const now = this.now();
    const due = Math.max(this.lastFlushAt + this.minEditIntervalMs, this.mutedUntil);
    if (now >= due && (trailing || growth >= this.minGrowthChars)) {
      this.flush();
      return;
    }
    if (this.cancelTimer === null) {
      // Not yet due: wake when it is. Due but too little new text: give
      // the model one more interval, then show whatever has arrived.
      const wait = now < due ? due - now : this.minEditIntervalMs;
      this.cancelTimer = this.schedule(() => {
        this.cancelTimer = null;
        this.maybeFlush(true);
      }, wait);
    }
  }

  private flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.lastFlushAt = this.now();
    this.renderedLength = this.text.length;
    const snapshot = this.text;
    this.chain = this.chain.then(() => this.render(snapshot)).catch(() => undefined);
  }

  /** Bring the bubbles up to `snapshot`: edit changed ones, post new ones. */
  private async render(snapshot: string): Promise<void> {
    const pieces = chunkUtf16(snapshot, this.bubbleChars);
    for (let i = 0; i < pieces.length; i += 1) {
      if (this.closed || this.broken) return;
      const piece = pieces[i]!;
      const bubble = this.bubbles[i];
      if (bubble?.shown === piece || piece.trim().length === 0) continue;
      try {
        if (bubble) {
          await this.opts.api.editMessageText!(this.opts.chatId, bubble.id, piece);
          bubble.shown = piece;
        } else {
          // Kept even if `finalize` began meanwhile: it runs after this
          // render on the chain and replaces the bubble like the others.
          const id = await this.post(piece);
          if (id === null) return this.stopStreaming("sendMessage returned no message id");
          this.bubbles.push({ id, shown: piece });
        }
      } catch (err) {
        const seconds = floodWaitSeconds(err);
        if (seconds !== null) {
          // Pause; the trailing flush re-renders everything once allowed.
          this.mutedUntil = this.now() + seconds * 1000;
          this.renderedLength = 0;
          this.maybeFlush(true);
          return;
        }
        if (isNotModified(err)) {
          if (bubble) bubble.shown = piece;
          continue;
        }
        return this.stopStreaming(stringifyError(err));
      }
    }
  }

  private async post(piece: string): Promise<number | null> {
    const sent = await this.opts.api.sendMessage(
      this.opts.chatId,
      piece,
      withThread(undefined, this.opts.threadId),
    );
    const id =
      typeof sent === "object" && sent !== null && "message_id" in sent
        ? (sent as { message_id?: unknown }).message_id
        : undefined;
    return typeof id === "number" ? id : null;
  }

  /** A non-flood failure: stop live edits; `finalize` still delivers. */
  private stopStreaming(error: string): void {
    this.broken = true;
    this.opts.logger?.warn("telegram: live reply stopped streaming (non-fatal)", {
      chatId: this.opts.chatId,
      error,
    });
  }

  private finalEdit(messageId: number): FinalEditTarget {
    return {
      api: this.opts.api,
      chatId: this.opts.chatId,
      messageId,
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      ...(this.opts.floodRetryBudgetMs !== undefined
        ? { floodRetryBudgetMs: this.opts.floodRetryBudgetMs }
        : {}),
    };
  }

  private async deleteBubbles(from: number): Promise<void> {
    const stale = this.bubbles.splice(from);
    for (const bubble of stale) {
      await Promise.resolve(this.opts.api.deleteMessage?.(this.opts.chatId, bubble.id)).catch(
        () => undefined,
      );
    }
  }
}

function scheduleUnrefTimeout(cb: () => void, ms: number): () => void {
  const timer = setTimeout(cb, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
