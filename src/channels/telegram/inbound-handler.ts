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
import {
  progressLabel,
  TelegramProgressIndicator,
} from "./telegram-progress-indicator.js";
import {
  telegramChatKey,
  type TelegramSessionPointer,
} from "./telegram-session-pointer.js";

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
 * Minimal shape of a Telegram text-message update consumed by the
 * inbound handler. Defining this structurally lets tests fabricate
 * updates without depending on the grammy `Context` type tree; the
 * `telegram-bot-factory.ts` adapter projects real updates onto this
 * shape.
 */
export interface InboundTextUpdate {
  from?: { id: number };
  chat: { id: number; type: string; title?: string };
  text: string;
  message_id: number;
  /** Set on every message inside a forum topic (and on replies). */
  message_thread_id?: number;
  /** `true` only for messages inside a forum topic — see `threadOf`. */
  is_topic_message?: boolean;
  /** The message this one replies to, when it is a reply. */
  reply_to_message?: { from?: { id: number; is_bot?: boolean } };
}

/**
 * Where a reply goes: the chat, plus the forum topic when the message
 * came from one. Every outbound path (reply, progress bubble, approval
 * keyboard, typing action) takes this pair so a conversation inside a
 * topic never leaks into the group's General topic.
 */
export interface TelegramTarget {
  chatId: number;
  threadId?: number;
}

/** The bot's own identity, from `getMe`. */
export interface TelegramBotIdentity {
  id: number;
  username: string | null;
  canReadAllGroupMessages?: boolean;
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
   * The bot's own identity from `getMe`. Needed to tell when a group
   * message is addressed to us (`@username` mention, reply to one of
   * our messages, `/cmd@username`). `null`/absent means group messages
   * cannot be attributed and are dropped — DMs still work.
   * `canReadAllGroupMessages` mirrors `getMe.can_read_all_group_messages`:
   * with privacy mode on (the BotFather default) Telegram never delivers
   * a plain `@username` mention in a group, only replies and `/cmd@bot`,
   * so the help text says which forms actually work.
   */
  botIdentity?: TelegramBotIdentity | null;
  /**
   * Channel-owned map of `chatKey -> AbortController` for the in-flight
   * turn in that chat (or topic). Updated by `dispatchToRuntime`;
   * consulted by `/cancel`. Holding it on the channel instead of the
   * handler keeps the handler stateless.
   */
  inflight: Map<string, AbortController>;
  /**
   * Bind the approval router so a request for `sessionId` lands on
   * the Telegram inline-keyboard bridge in `target`. Provided by
   * `TelegramChannel`; absent in slice 1-style tests that only
   * exercise the text path. Idempotent — the channel no-ops when the
   * binding is already current.
   */
  ensureApprovalSession?: (sessionId: string, target: TelegramTarget) => void;
  /**
   * Drop the approval binding for a session this chat no longer talks
   * to (`/new`, `/switch`). Optional for the same reason as above.
   */
  releaseApprovalSession?: (sessionId: string) => void;
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

function helpText(ctx: InboundContext): string {
  const bot = ctx.botIdentity ?? null;
  const cmd = bot?.username ? `/cmd@${bot.username}` : "/cmd@<bot>";
  // Privacy mode (BotFather default) withholds plain @mentions in
  // groups; only replies to the bot and targeted commands get through.
  const groupLine =
    bot?.canReadAllGroupMessages === false
      ? `In a group, reply to one of my messages or use ${cmd} — plain @mentions ` +
        "are not delivered while privacy mode is on (BotFather → /setprivacy → Disable, then re-add me).\n"
      : `In a group, @mention me, reply to one of my messages, or use ${cmd}.\n`;
  return (
    "atomic-agent — Telegram remote control\n\n" +
    "DM me and I'll act on it.\n" +
    groupLine +
    "Every chat and forum topic is its own conversation.\n\n" +
    "Commands:\n" +
  "  /start, /help — this message\n" +
  "  /status — this chat's session id and progress counters\n" +
  "  /sessions — every chat this bot has a session for\n" +
  "  /switch <session-id> — point this chat at an existing session\n" +
    "  /new — rotate this chat to a fresh session (current one is archived)\n" +
    "  /cancel — abort this chat's current turn if one is running"
  );
}

/** Where a message came from, resolved once per update. */
interface ChatRef {
  target: TelegramTarget;
  /** Key into the session map. */
  key: string;
  /** `true` for a private chat with the owner. */
  isPrivate: boolean;
  /** Human label for `/sessions` and session metadata. */
  label: string;
  chatType: string;
}

/**
 * Entry point — decide whether to drop, route to a slash command, or
 * dispatch to the agent loop. Always returns; never throws past this
 * boundary so a single bad update can never crash the channel.
 */
export async function handleInboundText(
  update: InboundTextUpdate,
  ctx: InboundContext,
): Promise<void> {
  const chatType = update.chat.type;
  const isPrivate = chatType === "private";
  const isGroup = chatType === "group" || chatType === "supergroup";
  // Broadcast channels (and anything unknown) cannot hold a
  // conversation: no `from`, no way to address the bot.
  if (!isPrivate && !isGroup) return;
  const fromId = update.from?.id;
  if (typeof fromId !== "number") return;
  // In a group the bot must be addressed explicitly: an @mention, a
  // reply to one of its messages, or `/cmd@bot`. Without this the
  // agent would act on every line the owner types in any group it
  // was added to. Checked first so ordinary group chatter from other
  // members is dropped silently — only a non-owner who actually
  // addresses the bot is worth a warn line.
  const addressed = isPrivate
    ? { text: update.text }
    : addressedText(update, ctx.botIdentity ?? null);
  if (addressed === null) return;
  // Pairing wins over the owner check: the whole point of a pairing
  // window is to accept the *first* eligible DM as the new owner,
  // even when `ownerUserId` is currently null or set to someone else.
  // The channel persists the new owner and restarts; the original
  // (claiming) message is consumed silently here so the operator
  // never sees their pairing trigger echoed back through the agent.
  // Only private chats can pair — a group member must not be able to
  // claim the bot by being first to speak.
  if (isPrivate && ctx.tryClaimForPairing?.(update)) {
    ctx.logger.info("telegram: pairing claimed by inbound DM", {
      fromId,
      chatId: update.chat.id,
    });
    return;
  }
  if (ctx.ownerUserId === null || fromId !== ctx.ownerUserId) {
    ctx.logger.warn("telegram: dropping non-owner message", {
      fromId,
      chatId: update.chat.id,
      chatType,
      ownerConfigured: ctx.ownerUserId !== null,
    });
    return;
  }
  const text = addressed.text.trim();
  if (text.length === 0) return;

  ctx.onMessageReceived?.();
  const ref = chatRefOf(update, isPrivate);
  // Resolve the pre-per-chat pointer before anything reads this chat's
  // entry, so `/status`, `/new` and `/switch` act on the real session
  // rather than on an empty entry that the next text message would
  // then silently fill from `legacy`.
  adoptLegacyForDm(ref, ctx);
  if (text.startsWith("/")) {
    await handleSlashCommand(text, ref, ctx);
    return;
  }
  await dispatchToRuntime(text, ref, ctx);
}

/**
 * Decide whether a group message is for this bot and, if so, return
 * the text with the addressing stripped. `null` means "not for us".
 *
 * Accepted forms:
 *  - a reply to one of the bot's own messages;
 *  - `@username` anywhere in the text (leading one is stripped);
 *  - a slash command targeted at the bot: `/new@username`.
 *
 * A bare `/cmd` in a group is deliberately *not* accepted — Telegram
 * delivers it to every bot in the group and answering would collide
 * with whichever bot it was meant for.
 */
export function addressedText(
  update: InboundTextUpdate,
  bot: { id: number; username: string | null } | null,
): { text: string } | null {
  if (!bot) return null;
  const replyFrom = update.reply_to_message?.from;
  if (replyFrom && replyFrom.id === bot.id) {
    return { text: stripBotMention(update.text, bot.username) };
  }
  if (!bot.username) return null;
  const u = escapeRegExp(bot.username);
  // Telegram's own rule (tdlib): a mention is `@username` not glued to
  // a letter, digit or underscore on either side — so "(@bot)" and
  // "hi,@bot" count, "x@bot" and "@bot_v2" do not.
  const mention = new RegExp(`(?<![\\p{L}\\p{N}_])@${u}(?![\\p{L}\\p{N}_])`, "iu");
  const targetedCommand = new RegExp(
    `^\\s*/[A-Za-z0-9_]+@${u}(?![\\p{L}\\p{N}_])`,
    "iu",
  );
  if (mention.test(update.text) || targetedCommand.test(update.text)) {
    return { text: stripBotMention(update.text, bot.username) };
  }
  return null;
}

/**
 * Remove a *leading* `@username` and the `@username` suffix on a slash
 * command (`/new@bot` → `/new`) so the agent sees the request, not the
 * addressing. A mention later in the sentence ("ask @bot about it") is
 * content and stays.
 */
export function stripBotMention(text: string, username: string | null): string {
  if (!username) return text;
  const u = escapeRegExp(username);
  return text
    .replace(new RegExp(`^\\s*[(\\[]?@${u}(?![\\p{L}\\p{N}_])[)\\]]?[\\s,:]*`, "iu"), "")
    .replace(new RegExp(`^(/[A-Za-z0-9_]+)@${u}(?![\\p{L}\\p{N}_])`, "iu"), "$1");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Forum-topic id for the update, or `undefined` outside topics. */
export function threadOf(update: InboundTextUpdate): number | undefined {
  // `message_thread_id` is also set on plain replies in non-forum
  // groups (it is the reply chain's root). Only `is_topic_message`
  // marks a real forum topic, which is the only case where replies
  // need routing.
  return update.is_topic_message === true &&
    typeof update.message_thread_id === "number"
    ? update.message_thread_id
    : undefined;
}

function chatRefOf(update: InboundTextUpdate, isPrivate: boolean): ChatRef {
  const threadId = threadOf(update);
  const target: TelegramTarget =
    threadId === undefined
      ? { chatId: update.chat.id }
      : { chatId: update.chat.id, threadId };
  const title = update.chat.title?.trim();
  const base = isPrivate ? "DM" : title && title.length > 0 ? title : `chat ${update.chat.id}`;
  return {
    target,
    key: telegramChatKey(update.chat.id, threadId),
    isPrivate,
    label: threadId === undefined ? base : `${base} › topic ${threadId}`,
    chatType: update.chat.type,
  };
}

async function handleSlashCommand(
  text: string,
  ref: ChatRef,
  ctx: InboundContext,
): Promise<void> {
  const [verb, ...rest] = text.split(/\s+/);
  switch (verb) {
    case "/start":
    case "/help":
      await sendText(ctx, ref.target, helpText(ctx));
      return;
    case "/status":
      await sendText(ctx, ref.target, formatStatus(ref, ctx));
      return;
    case "/sessions":
      await sendText(ctx, ref.target, formatSessions(ref, ctx));
      return;
    case "/switch": {
      await switchSession(rest[0], ref, ctx);
      return;
    }
    case "/new": {
      const previous = ctx.sessionPointer.get(ref.key).current;
      ctx.sessionPointer.rotate(ref.key);
      // A turn still running on the old session keeps its approval
      // keyboard until it settles — `dispatchToRuntime` releases then.
      if (previous && !ctx.inflight.has(ref.key)) {
        ctx.releaseApprovalSession?.(previous);
      }
      ctx.logger.info("telegram: rotated session", {
        chatKey: ref.key,
        previousSessionId: previous,
      });
      await sendText(
        ctx,
        ref.target,
        previous
          ? `Started a new session for this chat. Previous session ${previous} archived.`
          : "Started a new session for this chat.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(ref.key);
      if (!controller) {
        await sendText(ctx, ref.target, "No turn in progress in this chat.");
        return;
      }
      controller.abort();
      await sendText(ctx, ref.target, "Cancelling current turn…");
      return;
    }
    default:
      await sendText(
        ctx,
        ref.target,
        `Unknown command: ${verb}. Try /help.`,
      );
  }
}

async function switchSession(
  sessionId: string | undefined,
  ref: ChatRef,
  ctx: InboundContext,
): Promise<void> {
  if (!sessionId) {
    await sendText(
      ctx,
      ref.target,
      "Usage: /switch <session-id> — see /sessions for ids.",
    );
    return;
  }
  const current = ctx.sessionPointer.get(ref.key).current;
  if (current === sessionId) {
    await sendText(ctx, ref.target, `This chat is already on ${sessionId}.`);
    return;
  }
  const session = ctx.runtime.sessionStore.load(sessionId);
  if (!session) {
    await sendText(ctx, ref.target, `Unknown session ${sessionId}.`);
    return;
  }
  // Telegram sessions only. The TUI's and Discord's sessions live in
  // the same store; pulling one here would re-route its approvals to
  // this chat and interleave its turns with ours.
  if (session.metadata.telegramChannel !== true) {
    await sendText(
      ctx,
      ref.target,
      `Session ${sessionId} belongs to another surface (TUI or another channel); continue it there.`,
    );
    return;
  }
  // One session, one chat: two chats feeding the same session would
  // interleave their turns and bounce approval prompts between them.
  const holder = ctx.sessionPointer
    .entries()
    .find((e) => e.chatKey !== ref.key && e.entry.current === sessionId);
  if (holder) {
    await sendText(
      ctx,
      ref.target,
      `Session ${sessionId} is active in another chat (${holder.entry.label ?? holder.chatKey}). Run /new there first.`,
    );
    return;
  }
  if (ctx.runtime.turnController.isBusy(sessionId)) {
    await sendText(
      ctx,
      ref.target,
      `Session ${sessionId} has a turn in progress; try again when it finishes.`,
    );
    return;
  }
  if (current && !ctx.inflight.has(ref.key)) {
    ctx.releaseApprovalSession?.(current);
  }
  ctx.sessionPointer.setCurrent(ref.key, sessionId, ref.label);
  ctx.logger.info("telegram: switched session", {
    chatKey: ref.key,
    previousSessionId: current,
    sessionId,
  });
  await sendText(
    ctx,
    ref.target,
    current
      ? `This chat now continues session ${sessionId}. Previous session ${current} archived.`
      : `This chat now continues session ${sessionId}.`,
  );
}

async function dispatchToRuntime(
  text: string,
  ref: ChatRef,
  ctx: InboundContext,
): Promise<void> {
  const session = acquireOrCreateSession(ref, ctx);
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
  ctx.ensureApprovalSession?.(session.id, ref.target);
  const controller = new AbortController();
  ctx.inflight.set(ref.key, controller);

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
      ? new TelegramProgressIndicator(
          ctx.api,
          ref.target.chatId,
          toTelegramLogger(ctx.logger),
          undefined,
          ref.target.threadId,
        )
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
  const stopKeepalive = startTypingKeepalive(ctx, ref.target);
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
        ref.target,
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
    if (ctx.inflight.get(ref.key) === controller) {
      ctx.inflight.delete(ref.key);
    }
    releaseIfMovedOn(ref, session.id, ctx);
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
    await sendText(ctx, ref.target, "Turn cancelled.");
  } else if (reply !== null) {
    await sendText(ctx, ref.target, reply, ctx.agentReplyParseMode ?? "plain");
  } else if (failure) {
    await sendText(ctx, ref.target, formatFailure(failure));
  } else {
    await sendText(ctx, ref.target, "(no reply)");
  }
  // Count one outbound message per logical agent reply (not per
  // sendMessage chunk). Status-only confirmations from slash
  // commands (`/help`, `/status`, etc.) are excluded — they are
  // not agent-driven. Optional chain matches the inbound counter.
  ctx.runtime.metrics?.recordTelegramMessage({ direction: "out" });
}

/**
 * The session this chat talks to. Order of preference: the chat's own
 * entry; the pre-per-chat v1 pointer (DMs only — that shared session
 * was the owner's DM in practice); a fresh session stamped with where
 * it came from.
 */
function acquireOrCreateSession(ref: ChatRef, ctx: InboundContext): SessionState {
  const current = ctx.sessionPointer.get(ref.key).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("telegram: pointer references missing session, recreating", {
      chatKey: ref.key,
      sessionId: current,
    });
    // Nothing can ever request approval for a session that is gone.
    ctx.releaseApprovalSession?.(current);
  }
  const chat: Record<string, unknown> = {
    id: ref.target.chatId,
    type: ref.chatType,
    label: ref.label,
  };
  if (ref.target.threadId !== undefined) chat.threadId = ref.target.threadId;
  const fresh = ctx.runtime.createSession({
    metadata: { telegramChannel: true, telegramChat: chat },
  });
  ctx.sessionPointer.setCurrent(ref.key, fresh.id, ref.label);
  return fresh;
}

/**
 * Hand the pre-per-chat v1 pointer to the owner's DM the first time the
 * DM is heard from after the upgrade — whatever the message is. Groups
 * never inherit it: the old shared session was the DM in practice.
 */
function adoptLegacyForDm(ref: ChatRef, ctx: InboundContext): void {
  if (!ref.isPrivate) return;
  const adopted = ctx.sessionPointer.adoptLegacy(ref.key, ref.label);
  if (adopted) {
    ctx.logger.info("telegram: adopted pre-per-chat session for DM", {
      chatKey: ref.key,
      sessionId: adopted,
    });
  }
}

/**
 * After a turn settles: if the chat has meanwhile moved to another
 * session (`/new`, `/switch`) and no other chat picked this one up,
 * drop its approval binding. Deferred to here so a `/new` typed while
 * the turn was running never cut the keyboard off from the turn.
 */
function releaseIfMovedOn(ref: ChatRef, sessionId: string, ctx: InboundContext): void {
  if (ctx.sessionPointer.get(ref.key).current === sessionId) return;
  const heldElsewhere = ctx.sessionPointer
    .entries()
    .some((e) => e.entry.current === sessionId);
  if (heldElsewhere) return;
  ctx.releaseApprovalSession?.(sessionId);
}

function startTypingKeepalive(
  ctx: InboundContext,
  target: TelegramTarget,
): () => void {
  const sendTyping = (): void => {
    void Promise.resolve(
      ctx.api.sendChatAction?.(
        target.chatId,
        "typing",
        target.threadId === undefined
          ? undefined
          : { message_thread_id: target.threadId },
      ),
    ).catch(() => undefined);
  };
  sendTyping();
  if (ctx.scheduleKeepalive) {
    return ctx.scheduleKeepalive(sendTyping, TYPING_KEEPALIVE_MS);
  }
  const handle = setInterval(sendTyping, TYPING_KEEPALIVE_MS);
  return () => clearInterval(handle);
}

function formatStatus(ref: ChatRef, ctx: InboundContext): string {
  const entry = ctx.sessionPointer.get(ref.key);
  if (!entry.current) {
    return "No active session for this chat — your next message starts a fresh one.";
  }
  const session = ctx.runtime.sessionStore.load(entry.current);
  if (!session) {
    return `Pointer references missing session ${entry.current}.`;
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

function formatSessions(ref: ChatRef, ctx: InboundContext): string {
  const entries = ctx.sessionPointer.entries();
  const lines = entries
    .filter((e) => e.entry.current || (e.entry.history?.length ?? 0) > 0)
    .map((e) => {
      const here = e.chatKey === ref.key ? " (this chat)" : "";
      const label = e.entry.label ?? e.chatKey;
      const current = e.entry.current ?? "no active session";
      const archived = e.entry.history?.length ?? 0;
      const tail = archived > 0 ? `, ${archived} archived` : "";
      return `• ${label}${here}: ${current}${tail}`;
    });
  if (lines.length === 0) {
    return "No sessions yet — send a message to start one.";
  }
  return [
    "Sessions by chat:",
    ...lines,
    "",
    "/switch <session-id> points this chat at one of them.",
  ].join("\n");
}

function formatFailure(failure: {
  error: Error;
  category: LlmFailureCategory;
}): string {
  return `Turn failed [${failure.category}]: ${failure.error.message}`;
}

async function sendText(
  ctx: InboundContext,
  target: TelegramTarget,
  text: string,
  parseMode: TelegramParseMode = "plain",
): Promise<void> {
  const result = await sendOutbound({
    api: ctx.api,
    chatId: target.chatId,
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    text,
    parseMode,
    logger: toTelegramLogger(ctx.logger),
  });
  if (result.chunks > result.dropped) {
    ctx.onMessageSent?.(result.chunks - result.dropped);
  }
}
