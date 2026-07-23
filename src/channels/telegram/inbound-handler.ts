import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import {
  sendOutbound,
  type TelegramApi,
  type TelegramLogger,
  type TelegramParseMode,
} from "./outbound-sender.js";
import type { TelegramSessionPointer } from "./telegram-session-pointer.js";

/**
 * Adapt the runtime's `StructuredLogger` to the narrow
 * `TelegramLogger` interface that `outbound-sender` consumes. A direct
 * cast (`logger as unknown as TelegramLogger`) compiles only because
 * of TS's nominal handling of classes with `private` fields — bypassing
 * the type-checker hides nothing today but would silently rot if the
 * `warn` signature ever drifts. The structural bridge below makes the
 * dependency explicit and gives us a single point to plumb extra log
 * levels when slice 2 starts using them.
 */
function toTelegramLogger(logger: StructuredLogger): TelegramLogger {
  return {
    warn: (message, context) => logger.warn(message, context),
  };
}

/**
 * Minimal shape of a Telegram private-message update consumed by the
 * inbound handler. Defining this structurally lets tests fabricate
 * updates without depending on the grammy `Context` type tree; the
 * `telegram-channel.ts` adapter projects real updates onto this shape.
 */
export interface InboundTextUpdate {
  from?: { id: number };
  chat: { id: number; type: string };
  text: string;
  message_id: number;
}

/**
 * Inbound dispatch dependencies. The channel constructs this once at
 * `start()` time and reuses it for every update — fields are stable
 * across messages and only the `inflight` map mutates.
 */
export interface InboundContext {
  runtime: AgentRuntime;
  api: TelegramApi;
  sessionPointer: TelegramSessionPointer;
  logger: StructuredLogger;
  ownerUserId: number | null;
  /**
   * Channel-owned map of `chatId -> AbortController` for the in-flight
   * turn on that chat. Updated by `dispatchToRuntime`; consulted by
   * `/cancel`. Holding it on the channel instead of the handler keeps
   * the handler stateless.
   */
  inflight: Map<number, AbortController>;
  /**
   * Bind the approval router so a request for `sessionId` lands on
   * the Telegram inline-keyboard bridge with the active `chatId`.
   * Provided by `TelegramChannel`; absent in slice 1-style tests
   * that only exercise the text path. Idempotent — the channel
   * no-ops when the binding is already current.
   */
  ensureApprovalSession?: (sessionId: string, chatId: number) => void;
  /**
   * Pairing-mode hook. Provided by `TelegramChannel` so a pairing
   * window can capture the next eligible DM as the new owner before
   * the owner check fires. Returns `true` when the update was
   * consumed by pairing (and must not be dispatched further). Absent
   * in slice 1-style tests that pre-configure the owner directly.
   */
  tryClaimForPairing?: (update: InboundTextUpdate) => boolean;
  /** Called whenever the handler successfully delivered a reply chunk. */
  onMessageSent?: (chunks: number) => void;
  /** Called whenever the handler accepted an inbound text message. */
  onMessageReceived?: () => void;
  /** Test seam — replaces `setInterval` for the typing-action keepalive. */
  scheduleKeepalive?: (cb: () => void, ms: number) => () => void;
  /**
   * Parse mode applied **only** to the agent's reply text. Slash-command
   * acks (`/help`, `/status`, `/new`, `/cancel`), infra messages
   * (`Turn cancelled.`, `(no reply)`), and failure envelopes
   * (`Turn failed [...]: ...`) always send as plain text regardless,
   * matching the AGENTS.md scope carve-out: only "agent content"
   * is formatted, "channel infrastructure" stays unformatted so the
   * operator can never misread a runtime error as agent output.
   * Defaults to `"plain"` when omitted.
   */
  agentReplyParseMode?: TelegramParseMode;
}

/** How long Telegram displays a `chatAction: "typing"` indicator. */
const TYPING_KEEPALIVE_MS = 4_000;

const HELP_TEXT =
  "atomic-agent — Telegram remote control\n\n" +
  "Send me a message and I'll act on it.\n\n" +
  "Commands:\n" +
  "  /start, /help — this message\n" +
  "  /status — show the active session id and progress counters\n" +
  "  /new — rotate to a fresh session (current one is archived)\n" +
  "  /cancel — abort the current turn if one is running";

/**
 * Entry point — decide whether to drop, route to a slash command, or
 * dispatch to the agent loop. Always returns; never throws past this
 * boundary so a single bad update can never crash the channel.
 */
export async function handleInboundText(
  update: InboundTextUpdate,
  ctx: InboundContext,
): Promise<void> {
  if (update.chat.type !== "private") return;
  const fromId = update.from?.id;
  if (typeof fromId !== "number") return;
  // Pairing wins over the owner check: the whole point of a pairing
  // window is to accept the *first* eligible DM as the new owner,
  // even when `ownerUserId` is currently null or set to someone else.
  // The channel persists the new owner and restarts; the original
  // (claiming) message is consumed silently here so the operator
  // never sees their pairing trigger echoed back through the agent.
  if (ctx.tryClaimForPairing?.(update)) {
    ctx.logger.info("telegram: pairing claimed by inbound DM", {
      fromId,
      chatId: update.chat.id,
    });
    return;
  }
  if (ctx.ownerUserId === null || fromId !== ctx.ownerUserId) {
    ctx.logger.warn("telegram: dropping non-owner DM", {
      fromId,
      ownerConfigured: ctx.ownerUserId !== null,
    });
    return;
  }
  ctx.onMessageReceived?.();
  const text = update.text.trim();
  if (text.length === 0) return;
  if (text.startsWith("/")) {
    await handleSlashCommand(text, update.chat.id, ctx);
    return;
  }
  await dispatchToRuntime(text, update.chat.id, ctx);
}

async function handleSlashCommand(
  text: string,
  chatId: number,
  ctx: InboundContext,
): Promise<void> {
  const [verb] = text.split(/\s+/, 1);
  switch (verb) {
    case "/start":
    case "/help":
      await sendText(ctx, chatId, HELP_TEXT);
      return;
    case "/status":
      await sendText(ctx, chatId, formatStatus(ctx));
      return;
    case "/new": {
      const previous = ctx.sessionPointer.read().current;
      ctx.sessionPointer.rotate();
      ctx.logger.info("telegram: rotated session", {
        previousSessionId: previous,
      });
      await sendText(
        ctx,
        chatId,
        previous
          ? `Started a new session. Previous session ${previous} archived.`
          : "Started a new session.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(chatId);
      if (!controller) {
        await sendText(ctx, chatId, "No turn in progress.");
        return;
      }
      controller.abort();
      await sendText(ctx, chatId, "Cancelling current turn…");
      return;
    }
    default:
      await sendText(
        ctx,
        chatId,
        `Unknown command: ${verb}. Try /help.`,
      );
  }
}

async function dispatchToRuntime(
  text: string,
  chatId: number,
  ctx: InboundContext,
): Promise<void> {
  const session = acquireOrCreateSession(ctx);
  // Count agent-visible inbound messages (post owner-check, post
  // slash-command-shortcut). Slash commands and dropped non-owner
  // DMs are intentionally excluded — they never reach `runTurn`.
  // Optional chain shields hand-rolled test mocks from depending on
  // the full `AgentRuntime` shape.
  ctx.runtime.metrics?.recordTelegramMessage({ direction: "in" });
  // Re-bind the approval router for this session/chat pair before any
  // turn step can request approval — `ApprovalRouter.setForSession`
  // is the only path that turns a generic `ApprovalRequest` into a
  // 2-button keyboard in this chat. Idempotent on the channel side.
  ctx.ensureApprovalSession?.(session.id, chatId);
  const controller = new AbortController();
  ctx.inflight.set(chatId, controller);

  let reply: string | null = null;
  let failure: { error: Error; category: LlmFailureCategory } | null = null;
  // Live progress indicator: a single editable message that mirrors the
  // turn's activity ("Thinking…" → "🔧 <tool>" → "✅ <summary>") so the
  // operator gets immediate, visible feedback that their message landed.
  // The native `chatAction: "typing"` dots (kept running below) are too
  // subtle and vanish the instant a fast reply lands. Torn down before the
  // final reply is posted so the answer stands alone. Best-effort: a failed
  // post/edit/delete never affects the turn outcome.
  const progress = new TelegramProgressIndicator(
    ctx.api,
    chatId,
    toTelegramLogger(ctx.logger),
  );
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event") {
      if (event.event.type === "assistant_reply") reply = event.event.text;
    }
    if (event.type === "loop_failed") {
      failure = { error: event.error, category: event.category };
    }
    const label = progressLabel(event);
    if (label !== null) progress.update(label);
  };

  progress.start("🤔 Thinking…");
  const stopKeepalive = startTypingKeepalive(ctx, chatId);
  try {
    await ctx.runtime.runTurn(session, text, {
      origin: "telegram",
      signal: controller.signal,
      eventHook,
    });
  } catch (err) {
    failure = {
      error: err instanceof Error ? err : new Error(String(err)),
      category: "tool",
    };
  } finally {
    stopKeepalive();
    if (ctx.inflight.get(chatId) === controller) {
      ctx.inflight.delete(chatId);
    }
  }

  // Remove the progress indicator before posting the final text so the
  // reply (or infra message) stands alone rather than appearing above a
  // stale "Thinking…" bubble. Awaits the internal chain so a fast turn
  // whose `start()` send is still in flight is cleaned up before we send.
  await progress.remove();

  // Only the agent's natural-language reply gets parse-mode
  // formatting. Cancellation acks, the empty-reply marker, and
  // failure envelopes are channel infrastructure and stay plain so
  // the operator never confuses runtime telemetry with agent
  // content (and so a stray `<` in an error message can never
  // collide with the HTML grammar).
  if (controller.signal.aborted) {
    await sendText(ctx, chatId, "Turn cancelled.");
  } else if (reply !== null) {
    await sendText(ctx, chatId, reply, ctx.agentReplyParseMode ?? "plain");
  } else if (failure) {
    await sendText(ctx, chatId, formatFailure(failure));
  } else {
    await sendText(ctx, chatId, "(no reply)");
  }
  // Count one outbound message per logical agent reply (not per
  // sendMessage chunk). Status-only confirmations from slash
  // commands (`/help`, `/status`, etc.) are excluded — they are
  // not agent-driven. Optional chain matches the inbound counter.
  ctx.runtime.metrics?.recordTelegramMessage({ direction: "out" });
}

function acquireOrCreateSession(ctx: InboundContext): SessionState {
  const data = ctx.sessionPointer.read();
  if (data.current) {
    const existing = ctx.runtime.sessionStore.load(data.current);
    if (existing) return existing;
    ctx.logger.warn("telegram: pointer references missing session, recreating", {
      sessionId: data.current,
    });
  }
  const fresh = ctx.runtime.createSession({
    metadata: { telegramChannel: true },
  });
  ctx.sessionPointer.setCurrent(fresh.id);
  return fresh;
}

function startTypingKeepalive(
  ctx: InboundContext,
  chatId: number,
): () => void {
  const sendTyping = (): void => {
    void Promise.resolve(
      ctx.api.sendChatAction?.(chatId, "typing"),
    ).catch(() => undefined);
  };
  sendTyping();
  if (ctx.scheduleKeepalive) {
    return ctx.scheduleKeepalive(sendTyping, TYPING_KEEPALIVE_MS);
  }
  const handle = setInterval(sendTyping, TYPING_KEEPALIVE_MS);
  return () => clearInterval(handle);
}

/**
 * Maximum length of a `step_finished.summary` echoed into the live progress
 * bubble. Tool summaries can be long; clip so the indicator stays a glancable
 * status line rather than a second reply.
 */
const PROGRESS_SUMMARY_MAX_CHARS = 80;

/**
 * Minimum gap between two progress edits. Telegram rate-limits
 * `editMessageText` per chat; editing faster than this buys nothing visually
 * and risks 429 flood-waits. Combined with the "skip identical text" guard in
 * `update`, a chatty turn settles to at most ~1.4 edits/s.
 */
const PROGRESS_MIN_EDIT_INTERVAL_MS = 700;

function truncateForProgress(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PROGRESS_SUMMARY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PROGRESS_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Map an `AgentLoopEvent` to a short, operator-facing progress label, or
 * `null` when the event carries nothing worth surfacing (token accounting,
 * streaming deltas, the terminal `assistant_reply` which the reply path
 * already handles). Tool names are shown verbatim — they are stable,
 * meaningful identifiers (`os.fs.write`, `browser.navigate`, …) and inventing
 * friendlier verbs would drift from the tool registry.
 */
function progressLabel(event: AgentLoopEvent): string | null {
  switch (event.type) {
    case "turn_started":
      return "🤔 Thinking…";
    case "step_started":
      return `⚙️ Working… (step ${event.stepIndex + 1})`;
    case "step_finished": {
      const summary = event.summary.trim();
      return summary.length > 0 ? `✅ ${truncateForProgress(summary)}` : null;
    }
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
 */
class TelegramProgressIndicator {
  private messageId: number | null = null;
  private removed = false;
  private lastText = "";
  private lastEditAt = 0;
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
        const sent = await this.api.sendMessage(this.chatId, text);
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
    if (now - this.lastEditAt < this.minEditIntervalMs) return;
    this.lastText = text;
    this.lastEditAt = now;
    this.chain = this.chain.then(async () => {
      if (this.removed || this.messageId === null) return;
      try {
        await this.api.editMessageText?.(this.chatId, this.messageId, text);
      } catch {
        // "message is not modified", flood-wait, or already deleted — all
        // non-fatal for a best-effort indicator.
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

function formatStatus(ctx: InboundContext): string {
  const data = ctx.sessionPointer.read();
  if (!data.current) {
    return "No active session — your next message starts a fresh one.";
  }
  const session = ctx.runtime.sessionStore.load(data.current);
  if (!session) {
    return `Pointer references missing session ${data.current}.`;
  }
  const busy = ctx.runtime.turnController.isBusy(session.id);
  const lines = [
    `Session: ${session.id}`,
    `Status: ${session.status}${busy ? " (turn in progress)" : ""}`,
    `Turns: ${session.turnCount}, steps: ${session.stepCount}`,
  ];
  if (session.lastError) lines.push(`Last error: ${session.lastError}`);
  return lines.join("\n");
}

function formatFailure(failure: {
  error: Error;
  category: LlmFailureCategory;
}): string {
  return `Turn failed [${failure.category}]: ${failure.error.message}`;
}

async function sendText(
  ctx: InboundContext,
  chatId: number,
  text: string,
  parseMode: TelegramParseMode = "plain",
): Promise<void> {
  const result = await sendOutbound({
    api: ctx.api,
    chatId,
    text,
    parseMode,
    logger: toTelegramLogger(ctx.logger),
  });
  if (result.chunks > result.dropped) {
    ctx.onMessageSent?.(result.chunks - result.dropped);
  }
}
