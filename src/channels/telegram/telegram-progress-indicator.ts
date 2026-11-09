import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { maskSecrets } from "../../error-reporting/secret-detector.js";
import { describeToolCall } from "../../tools/describe-tool-call.js";

import {
  withThread,
  type TelegramApi,
  type TelegramLogger,
} from "./outbound-sender.js";

/**
 * Minimum gap between two progress edits. Telegram's practical per-chat
 * ceiling is about one message per second; staying at or above it keeps a
 * chatty turn from earning a flood-wait that would apply to the whole chat
 * (and therefore to the final reply, not just this bubble). Combined with
 * the "skip identical text" guard in `update`, a chatty turn settles to at
 * most 1 edit/s.
 */
const PROGRESS_MIN_EDIT_INTERVAL_MS = 1000;

/**
 * Map an `AgentLoopEvent` to a short, operator-facing progress label, or
 * `null` when the event carries nothing worth surfacing (token accounting,
 * streaming deltas, the terminal `assistant_reply` which the reply path
 * already handles). A tool call reads as a person would say it,
 * "🔧 Reading config.ts" rather than "🔧 os.fs.read" (ATO-962), from the
 * shared {@link describeToolCall} table the TUI and desktop use too.
 *
 * Labels never carry tool OUTPUT: `step_finished.summary` is deliberately
 * NOT echoed: it is the tail of the tool's raw output
 * (`compressToolResult`), so a grep hit or the start of a key could
 * otherwise end up in Telegram history, which is forwardable and outlives
 * the session. A call's line is built from the model's own arguments
 * (a file's base name, a URL's host, a clipped command), and is run
 * through the credential masker before and after, so a key typed into a
 * command reads `[redacted:…]`.
 */
export function progressLabel(event: AgentLoopEvent): string | null {
  switch (event.type) {
    case "turn_started":
      return "🤔 Thinking…";
    case "step_started":
      return `⚙️ Working… (step ${event.stepIndex + 1})`;
    case "step_finished":
      return `✅ Step ${event.stepIndex + 1} done`;
    case "loop_detected":
      return `🔁 Repeating ${event.tool} (×${event.count})`;
    case "llm_event": {
      const step = event.event;
      if (step.type === "tool_call_parsed") return `🔧 ${toolCallLabel(step.call.tool, step.call.args)}`;
      return null;
    }
    default:
      return null;
  }
}

/** The running form of one call, with credentials masked. Never throws. */
function toolCallLabel(tool: string, args: unknown): string {
  let masked: unknown = args;
  try {
    masked = maskSecrets(JSON.stringify(args ?? {}));
  } catch {
    masked = {};
  }
  return maskSecrets(describeToolCall({ name: tool, args: masked }).line);
}

/**
 * Extract `retry_after` seconds from a Telegram 429 error, or `null` when
 * the error is anything else. Structural, so it works for grammy's
 * `GrammyError` and for hand-rolled fakes alike.
 */
export function retryAfterSeconds(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { error_code?: unknown }).error_code;
  if (code !== 429) return null;
  const params = (err as { parameters?: { retry_after?: unknown } }).parameters;
  const after = params?.retry_after;
  return typeof after === "number" && after > 0 ? after : 1;
}

/**
 * Telegram's answer to an edit whose text did not change. Not a failure:
 * the bubble already shows what we wanted.
 */
export function isNotModified(err: unknown): boolean {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null
        ? String((err as { description?: unknown }).description ?? "")
        : String(err);
  return /message is not modified/i.test(text);
}

/**
 * A single editable Telegram message that mirrors the current turn's
 * activity, giving the operator immediate visible feedback that their
 * message landed and is being worked on. Lifecycle: `start()` posts the
 * bubble, `update()` edits it (throttled + deduped), `remove()` deletes it
 * once the turn settles. Every network call is best-effort and serialised
 * through an internal promise chain so a fast turn that calls `remove()`
 * before `start()`'s `sendMessage` resolves still cleans up correctly (the
 * send handler observes `removed` and deletes the just-posted message).
 * Failures are logged (start) or swallowed (edit/delete) — the indicator is
 * pure channel infrastructure and must never affect the turn outcome.
 *
 * The bubble is sent with `disable_notification: true`: the operator
 * already gets a push for the final reply, and a second ping for a
 * transient status line that deletes itself would double-notify every
 * message.
 *
 * A 429 on an edit mutes further edits for the server-provided
 * `retry_after` window instead of continuing to hit the limit — a
 * flood-wait earned here applies to the whole chat and could delay the
 * final reply.
 */
export class TelegramProgressIndicator {
  private messageId: number | null = null;
  private removed = false;
  private lastText = "";
  private lastEditAt = 0;
  private mutedUntil = 0;
  /** Set by `showSnapshot`: the bubble now holds a status snapshot. */
  private snapshotMode = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    private readonly logger?: TelegramLogger,
    private readonly minEditIntervalMs: number = PROGRESS_MIN_EDIT_INTERVAL_MS,
    /** Forum-topic id so the bubble appears in the topic that asked. */
    private readonly threadId?: number,
  ) {}

  /** Post the initial indicator bubble. Fire-and-forget. */
  start(text: string): void {
    this.lastText = text;
    this.chain = this.chain.then(async () => {
      if (this.removed) return;
      try {
        const sent = await this.api.sendMessage(
          this.chatId,
          text,
          withThread({ disable_notification: true }, this.threadId),
        );
        const messageId =
          typeof sent === "object" && sent !== null && "message_id" in sent
            ? (sent as { message_id?: number }).message_id
            : undefined;
        if (this.removed) {
          // The turn finished while we were sending; don't leave a stale
          // bubble behind.
          if (typeof messageId === "number") {
            await this.api
              .deleteMessage?.(this.chatId, messageId)
              .catch(() => undefined);
          }
          return;
        }
        this.messageId = typeof messageId === "number" ? messageId : null;
        this.lastEditAt = Date.now();
      } catch (err) {
        this.logger?.warn("telegram: progress start failed (non-fatal)", {
          chatId: this.chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** Throttled, deduped live update. Fire-and-forget. */
  update(text: string): void {
    // A status snapshot (ATO-965) holds the bubble until the next one;
    // a one-word step label must not overwrite it a second later.
    if (this.snapshotMode) return;
    if (this.removed || text === this.lastText) return;
    const now = Date.now();
    if (now < this.mutedUntil) return;
    if (now - this.lastEditAt < this.minEditIntervalMs) return;
    this.lastText = text;
    this.lastEditAt = now;
    this.chain = this.chain.then(async () => {
      if (this.removed || this.messageId === null) return;
      try {
        await this.api.editMessageText?.(this.chatId, this.messageId, text);
      } catch (err) {
        // "message is not modified" or already deleted — non-fatal for a
        // best-effort indicator. A flood-wait additionally mutes edits for
        // the window Telegram asked for, so the bubble cannot keep earning
        // penalties that would land on the final reply.
        const after = retryAfterSeconds(err);
        if (after !== null) {
          this.mutedUntil = Date.now() + after * 1000;
        }
      }
    });
  }

  /**
   * Put a status snapshot (ATO-965) in the bubble: edit it in place, so a
   * long turn or task keeps ONE updating message instead of a new one
   * per snapshot. Not throttled (the caller's cadence already is, every
   * N steps or M minutes) but a 429 mute still holds. When the edit
   * fails for any other reason than "not modified" (the bubble was
   * deleted, or is too old to edit), a new bubble is posted and edited
   * from then on; the old one is deleted best-effort. Posts the bubble
   * when there is none yet. Fire-and-forget; resolves when settled.
   */
  showSnapshot(text: string): Promise<void> {
    if (this.removed) return Promise.resolve();
    this.snapshotMode = true;
    if (text === this.lastText && this.messageId !== null) {
      return this.chain.then(() => undefined);
    }
    this.lastText = text;
    this.chain = this.chain.then(async () => {
      if (this.removed) return;
      if (Date.now() < this.mutedUntil) return;
      if (this.messageId !== null) {
        try {
          await this.requireEdit(this.messageId, text);
          this.lastEditAt = Date.now();
          return;
        } catch (err) {
          const after = retryAfterSeconds(err);
          if (after !== null) {
            this.mutedUntil = Date.now() + after * 1000;
            return;
          }
          if (isNotModified(err)) return;
          const stale = this.messageId;
          this.messageId = null;
          void Promise.resolve(this.api.deleteMessage?.(this.chatId, stale)).catch(
            () => undefined,
          );
        }
      }
      await this.repost(text);
    });
    return this.chain.then(() => undefined);
  }

  /** The bubble's message id, once posted. Test and logging aid. */
  currentMessageId(): number | null {
    return this.messageId;
  }

  private async requireEdit(messageId: number, text: string): Promise<void> {
    if (!this.api.editMessageText) {
      throw new Error("editMessageText unavailable");
    }
    await this.api.editMessageText(this.chatId, messageId, text);
  }

  private async repost(text: string): Promise<void> {
    try {
      const sent = await this.api.sendMessage(
        this.chatId,
        text,
        withThread({ disable_notification: true }, this.threadId),
      );
      const messageId =
        typeof sent === "object" && sent !== null && "message_id" in sent
          ? (sent as { message_id?: number }).message_id
          : undefined;
      if (this.removed) {
        if (typeof messageId === "number") {
          await Promise.resolve(
            this.api.deleteMessage?.(this.chatId, messageId),
          ).catch(() => undefined);
        }
        return;
      }
      this.messageId = typeof messageId === "number" ? messageId : null;
      this.lastEditAt = Date.now();
    } catch (err) {
      const after = retryAfterSeconds(err);
      if (after !== null) this.mutedUntil = Date.now() + after * 1000;
      this.logger?.warn("telegram: status snapshot post failed (non-fatal)", {
        chatId: this.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Delete the indicator. Idempotent; resolves once the delete settles. */
  remove(): Promise<void> {
    this.removed = true;
    this.chain = this.chain.then(async () => {
      if (this.messageId === null) return;
      try {
        await this.api.deleteMessage?.(this.chatId, this.messageId);
      } catch {
        // Already gone or flood-wait — non-fatal.
      }
      this.messageId = null;
    });
    return this.chain.then(() => undefined);
  }
}
