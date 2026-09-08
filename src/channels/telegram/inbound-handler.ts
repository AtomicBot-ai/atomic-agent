import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import {
  buildAttachmentUserMessage,
  formatBytes,
  type AttachmentInbox,
  type AttachmentOutcome,
} from "../attachments/inbox.js";
import {
  sendOutbound,
  type TelegramApi,
  type TelegramLogger,
  type TelegramParseMode,
} from "./outbound-sender.js";
import { scrubErrorMessage } from "./telegram-channel-types.js";
import type {
  InboundFileUpdate,
  InboundTelegramFile,
} from "./telegram-file-update.js";
import {
  progressLabel,
  TelegramProgressIndicator,
} from "./telegram-progress-indicator.js";
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
   * Where inbound files land — `<stateDir>/inbox/telegram` in
   * production, a tmp dir in tests. The agent is told the saved path
   * and reads it with the ordinary fs / vision tools.
   */
  inbox: AttachmentInbox;
  /**
   * Channel-owned `media_group_id -> pending album` buffer. Telegram
   * delivers an album as one update per file; holding them for a
   * short window turns "five photos" into one turn instead of five.
   * Lives on the channel for the same reason `inflight` does, and so
   * `stop()` can cancel the timers.
   */
  mediaGroups: Map<string, PendingMediaGroup>;
  /** Test seam — replaces `setTimeout` for the album flush. */
  scheduleMediaGroupFlush?: (cb: () => void, ms: number) => () => void;
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
  /**
   * Live progress indicator toggle (`config.telegram.progressIndicator`).
   * Defaults to enabled when omitted; `false` suppresses the editable
   * "Thinking…" bubble entirely (the `typing` chat action keepalive still
   * runs). Captured by value at registration time, same as
   * `agentReplyParseMode`.
   */
  progressIndicator?: boolean;
}

/** How long Telegram displays a `chatAction: "typing"` indicator. */
const TYPING_KEEPALIVE_MS = 4_000;

/**
 * Bot API ceiling for `getFile`. Checked against the reported
 * `file_size` before any request goes out, so an oversized file costs
 * one plain-text notice rather than a round trip that ends in
 * `400: file is too big`.
 */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * How long after the last album member arrives before the album is
 * dispatched as one turn. Telegram sends the members of one
 * `media_group_id` back to back (usually inside a single `getUpdates`
 * batch), so a short debounce is enough; the window restarts on every
 * arrival, and downloads run in parallel underneath it.
 */
export const MEDIA_GROUP_WINDOW_MS = 1_500;

/** An album (`media_group_id`) whose members are still arriving. */
export interface PendingMediaGroup {
  chatId: number;
  /** First non-empty caption seen — Telegram attaches it to one member only. */
  caption: string | undefined;
  /** Per-member download + save, already in flight. Never rejects. */
  items: Promise<AttachmentOutcome>[];
  /** Cancels the pending flush timer. */
  cancel: () => void;
}

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

/**
 * File counterpart of `handleInboundText`. Same drop rules (private
 * chat, owner only, pairing first), then the file is downloaded and
 * saved into the inbox and the turn is dispatched with the caption
 * plus an `[attachments]` block naming the saved path. Album members
 * are buffered by `media_group_id` and dispatched together. Never
 * throws past this boundary.
 */
export async function handleInboundFile(
  update: InboundFileUpdate,
  ctx: InboundContext,
): Promise<void> {
  if (update.chat.type !== "private") return;
  const fromId = update.from?.id;
  if (typeof fromId !== "number") return;
  // A file DM is as valid a pairing claim as a text one — the operator
  // was told to "send the bot any message". Project it onto the text
  // shape the pairing state machine understands.
  const claimText = update.caption?.trim() || `[${update.file.kind}]`;
  if (
    ctx.tryClaimForPairing?.({
      from: { id: fromId },
      chat: update.chat,
      text: claimText,
      message_id: update.message_id,
    })
  ) {
    ctx.logger.info("telegram: pairing claimed by inbound file DM", {
      fromId,
      chatId: update.chat.id,
    });
    return;
  }
  if (ctx.ownerUserId === null || fromId !== ctx.ownerUserId) {
    ctx.logger.warn("telegram: dropping non-owner file DM", {
      fromId,
      ownerConfigured: ctx.ownerUserId !== null,
      kind: update.file.kind,
    });
    return;
  }
  ctx.onMessageReceived?.();
  const outcome = receiveAttachment(update.file, ctx);
  if (update.media_group_id !== undefined) {
    enqueueMediaGroup(
      update.media_group_id,
      update.chat.id,
      update.caption,
      outcome,
      ctx,
    );
    return;
  }
  await dispatchAttachments(update.chat.id, update.caption, [await outcome], ctx);
}

/**
 * Download + save one file. Every failure becomes a `failed` outcome
 * with a scrubbed reason — this promise never rejects, which is what
 * lets an album `Promise.all` its members without a single bad file
 * taking the rest down.
 */
async function receiveAttachment(
  file: InboundTelegramFile,
  ctx: InboundContext,
): Promise<AttachmentOutcome> {
  const name = file.file_name ?? file.kind;
  if (
    typeof file.file_size === "number" &&
    file.file_size > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES
  ) {
    return {
      status: "failed",
      name,
      reason: `Telegram bots cannot download files over ${formatBytes(TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES)}`,
    };
  }
  const download = ctx.api.downloadFile;
  if (!download) {
    return {
      status: "failed",
      name,
      reason: "file download is not supported by this bot adapter",
    };
  }
  try {
    const bytes = await download.call(ctx.api, file.file_id);
    const saved = await ctx.inbox.save({
      ...(file.file_name !== undefined ? { name: file.file_name } : {}),
      ...(file.mime_type !== undefined ? { mimeType: file.mime_type } : {}),
      bytes,
      kind: file.kind,
    });
    ctx.logger.info("telegram: attachment saved", {
      kind: file.kind,
      path: saved.path,
      bytes: saved.bytes,
    });
    return { status: "saved", saved };
  } catch (err) {
    const reason = scrubErrorMessage(err);
    ctx.logger.warn("telegram: attachment not saved", {
      kind: file.kind,
      error: reason,
    });
    return { status: "failed", name, reason };
  }
}

/**
 * Tell the operator about every file that did not make it (plain
 * text, channel infrastructure), then run the turn when there is
 * anything for the agent — at least one saved file or a caption.
 * A lone failed file with no caption ends here: the notice *is* the
 * reply.
 */
async function dispatchAttachments(
  chatId: number,
  caption: string | undefined,
  items: ReadonlyArray<AttachmentOutcome>,
  ctx: InboundContext,
): Promise<void> {
  for (const item of items) {
    if (item.status === "failed") {
      await sendText(ctx, chatId, `Could not receive ${item.name}: ${item.reason}`);
    }
  }
  const anySaved = items.some((item) => item.status === "saved");
  const text = caption?.trim() ?? "";
  if (!anySaved && text.length === 0) return;
  await dispatchToRuntime(buildAttachmentUserMessage(caption, items), chatId, ctx);
}

function enqueueMediaGroup(
  groupId: string,
  chatId: number,
  caption: string | undefined,
  outcome: Promise<AttachmentOutcome>,
  ctx: InboundContext,
): void {
  const existing = ctx.mediaGroups.get(groupId);
  if (existing) {
    existing.cancel();
    existing.items.push(outcome);
    if (existing.caption === undefined && caption !== undefined) {
      existing.caption = caption;
    }
    existing.cancel = scheduleMediaGroupFlush(groupId, ctx);
    return;
  }
  const group: PendingMediaGroup = {
    chatId,
    caption,
    items: [outcome],
    cancel: () => undefined,
  };
  ctx.mediaGroups.set(groupId, group);
  group.cancel = scheduleMediaGroupFlush(groupId, ctx);
}

function scheduleMediaGroupFlush(
  groupId: string,
  ctx: InboundContext,
): () => void {
  const schedule = ctx.scheduleMediaGroupFlush ?? defaultScheduleOnce;
  return schedule(() => {
    flushMediaGroup(groupId, ctx).catch((err: unknown) => {
      ctx.logger.warn("telegram: album flush failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, MEDIA_GROUP_WINDOW_MS);
}

async function flushMediaGroup(
  groupId: string,
  ctx: InboundContext,
): Promise<void> {
  const group = ctx.mediaGroups.get(groupId);
  if (!group) return;
  ctx.mediaGroups.delete(groupId);
  const items = await Promise.all(group.items);
  await dispatchAttachments(group.chatId, group.caption, items, ctx);
}

function defaultScheduleOnce(cb: () => void, ms: number): () => void {
  const handle = setTimeout(cb, ms);
  // A pending album must never keep the process alive past shutdown.
  if (typeof (handle as { unref?: () => unknown }).unref === "function") {
    (handle as { unref: () => unknown }).unref();
  }
  return () => clearTimeout(handle);
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
  const progress =
    ctx.progressIndicator !== false
      ? new TelegramProgressIndicator(ctx.api, chatId, toTelegramLogger(ctx.logger))
      : null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event") {
      if (event.event.type === "assistant_reply") reply = event.event.text;
    }
    if (event.type === "loop_failed") {
      failure = { error: event.error, category: event.category };
    }
    if (progress === null) return;
    const label = progressLabel(event);
    if (label !== null) progress.update(label);
  };

  progress?.start("🤔 Thinking…");
  const stopKeepalive = startTypingKeepalive(ctx, chatId);
  try {
    const result = await ctx.runtime.runTurn(session, text, {
      origin: "telegram",
      signal: controller.signal,
      eventHook,
    });
    // A steer accepted for this turn but never delivered: the chat is
    // the host here, so tell it rather than dropping the text silently.
    if (result.undelivered !== undefined && result.undelivered.length > 0) {
      const lines = result.undelivered
        .map((t) => `• ${t.length > 120 ? `${t.slice(0, 119)}…` : t}`)
        .join("\n");
      await sendText(
        ctx,
        chatId,
        `A message arrived too late for that turn and was not applied:\n${lines}`,
      );
    }
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
  await progress?.remove();

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
