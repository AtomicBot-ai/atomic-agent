import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import { sendOutbound, type TelegramApi, type TelegramLogger } from "./outbound-sender.js";
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
  /** Called whenever the handler successfully delivered a reply chunk. */
  onMessageSent?: (chunks: number) => void;
  /** Called whenever the handler accepted an inbound text message. */
  onMessageReceived?: () => void;
  /** Test seam — replaces `setInterval` for the typing-action keepalive. */
  scheduleKeepalive?: (cb: () => void, ms: number) => () => void;
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
  const controller = new AbortController();
  ctx.inflight.set(chatId, controller);

  let reply: string | null = null;
  let failure: { error: Error; category: LlmFailureCategory } | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event") {
      if (event.event.type === "assistant_reply") reply = event.event.text;
      return;
    }
    if (event.type === "loop_failed") {
      failure = { error: event.error, category: event.category };
    }
  };

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

  const final = controller.signal.aborted
    ? "Turn cancelled."
    : reply !== null
      ? reply
      : failure
        ? formatFailure(failure)
        : "(no reply)";
  await sendText(ctx, chatId, final);
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
): Promise<void> {
  const result = await sendOutbound({
    api: ctx.api,
    chatId,
    text,
    logger: toTelegramLogger(ctx.logger),
  });
  if (result.chunks > result.dropped) {
    ctx.onMessageSent?.(result.chunks - result.dropped);
  }
}
