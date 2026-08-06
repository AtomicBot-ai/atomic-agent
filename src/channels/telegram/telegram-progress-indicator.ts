import type { AgentLoopEvent } from "../../agent/agent-loop.js";

import type { TelegramApi, TelegramLogger } from "./outbound-sender.js";

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
 * already handles). Tool names are shown verbatim — they are stable,
 * meaningful identifiers (`os.fs.write`, `browser.navigate`, …) and inventing
 * friendlier verbs would drift from the tool registry.
 *
 * Every label is constructed here from stable identifiers only. In
 * particular, `step_finished.summary` is deliberately NOT echoed: it is the
 * tail of the tool's raw output (`compressToolResult`), so a file path, a
 * grep hit or the start of a key could otherwise end up in Telegram
 * history, which is forwardable and outlives the session.
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
      if (step.type === "tool_call_parsed") return `🔧 ${step.call.tool}`;
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract `retry_after` seconds from a Telegram 429 error, or `null` when
 * the error is anything else. Structural, so it works for grammy's
 * `GrammyError` and for hand-rolled fakes alike.
 */
function retryAfterSeconds(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { error_code?: unknown }).error_code;
  if (code !== 429) return null;
  const params = (err as { parameters?: { retry_after?: unknown } }).parameters;
  const after = params?.retry_after;
  return typeof after === "number" && after > 0 ? after : 1;
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
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    private readonly logger?: TelegramLogger,
    private readonly minEditIntervalMs: number = PROGRESS_MIN_EDIT_INTERVAL_MS,
  ) {}

  /** Post the initial indicator bubble. Fire-and-forget. */
  start(text: string): void {
    this.lastText = text;
    this.chain = this.chain.then(async () => {
      if (this.removed) return;
      try {
        const sent = await this.api.sendMessage(this.chatId, text, {
          disable_notification: true,
        });
        const messageId =
          typeof sent === "object" && sent !== null && "message_id" in sent
            ? (sent as { message_id?: number }).message_id
            : undefined;
        if (this.removed) {
          // The turn finished while we were sending; don't leave a stale
          // bubble behind.
          if (typeof messageId === "number") {
            await this.api.deleteMessage?.(this.chatId, messageId).catch(
              () => undefined,
            );
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
