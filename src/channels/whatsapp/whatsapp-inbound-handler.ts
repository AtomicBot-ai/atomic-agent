/**
 * Inbound dispatch for the WhatsApp channel (ATO-502): drop, answer an
 * approval, run a slash command, or run the message as an agent turn.
 *
 * Same hard rule as the other channel handlers: **never throw past this
 * boundary**, so one odd message cannot stop the socket listener.
 *
 * Each DM partner and each group is its own conversation (chat key
 * `dm:<jid>` / `group:<jid>`). Only owners drive the agent; an empty
 * owner list refuses everyone. Groups are ignored unless the operator
 * set `allowGroups`, and even then only owner messages count. Our own
 * messages, status updates and broadcasts never get here as messages
 * (see `parseWhatsAppMessage`).
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChannelContext } from "../channel.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { chunkMessage } from "../discord/discord-channel-types.js";
import { runModelCommand } from "../model-command.js";
import { sanitizeDisplayName } from "../sender-identity.js";
import type { WhatsAppApprovalBridge } from "./whatsapp-approval-bridge.js";
import {
  WHATSAPP_MESSAGE_LIMIT,
  chatKeyOf,
  parseWhatsAppMessage,
  scrubWhatsAppError,
  type RawWhatsAppMessage,
  type WhatsAppInbound,
} from "./whatsapp-types.js";

/** WhatsApp clears "typing..." after ~25 s; refresh sooner. */
const TYPING_REFRESH_MS = 10_000;
/** How many recent message ids to remember for redelivery checks. */
const SEEN_LIMIT = 500;

export interface WhatsAppInboundContext {
  runtime: ChannelContext["runtime"];
  logger: StructuredLogger;
  sessionMap: ChatSessionMap;
  /** Normalized owner JIDs. Empty = refuse all. */
  ownerIds: readonly string[];
  allowGroups: boolean;
  bridge: WhatsAppApprovalBridge;
  send: (chatJid: string, text: string) => Promise<void>;
  sendTyping?: (chatJid: string, on: boolean) => Promise<void>;
  /** `chatKey -> AbortController` for the turn running there. */
  inflight: Map<string, AbortController>;
  /** Recently handled message ids, oldest first; shared across calls. */
  seen: Set<string>;
  ensureApprovalSession: (sessionId: string, chatJid: string) => void;
  releaseApprovalSession: (sessionId: string) => void;
}

const HELP_TEXT = [
  "atomic-agent on WhatsApp",
  "",
  "Send me a message and I'll act on it. Each chat is its own conversation.",
  "",
  "/help - this message",
  "/status - this chat's session id",
  "/new - start a fresh session (the current one is archived)",
  "/model - show the model; /model <provider> [model-id] switches",
  "/cancel - stop the current turn",
  "",
  "Approvals: reply yes <code> or no <code>.",
].join("\n");

/** Entry point for one raw message from the socket. Always returns. */
export async function handleWhatsAppMessage(
  raw: RawWhatsAppMessage,
  ctx: WhatsAppInboundContext,
): Promise<void> {
  try {
    await route(raw, ctx);
  } catch (err) {
    ctx.logger.warn("whatsapp: inbound handler failed", { error: scrubWhatsAppError(err) });
  }
}

async function route(raw: RawWhatsAppMessage, ctx: WhatsAppInboundContext): Promise<void> {
  const parsed = parseWhatsAppMessage(raw);
  if (parsed.kind === "ignore") return;
  const msg = parsed.message;
  if (msg.id !== null) {
    if (ctx.seen.has(msg.id)) return;
    ctx.seen.add(msg.id);
    if (ctx.seen.size > SEEN_LIMIT) {
      const oldest = ctx.seen.values().next().value;
      if (oldest !== undefined) ctx.seen.delete(oldest);
    }
  }
  const isOwner = msg.senderIds.some((id) => ctx.ownerIds.includes(id));
  if (!isOwner) {
    // Ids are not logged: a phone number is personal data.
    ctx.logger.warn("whatsapp: dropping message from non-owner", {
      ownerConfigured: ctx.ownerIds.length > 0,
      inGroup: msg.isGroup,
    });
    return;
  }
  if (msg.isGroup && !ctx.allowGroups) {
    ctx.logger.info("whatsapp: ignoring group message (allowGroups is off)");
    return;
  }
  const chat = msg.chatJid;
  const text = msg.text.trim();

  const answer = ctx.bridge.tryAnswer(text, chat);
  if (answer !== null) {
    await reply(ctx, chat, answer);
    return;
  }
  if (msg.hasMedia) {
    await reply(
      ctx,
      chat,
      text.length > 0
        ? "Photos, voice notes and files are not supported on WhatsApp yet; I only read the text."
        : "Photos, voice notes and files are not supported on WhatsApp yet. Send the request as text.",
    );
    if (text.length === 0) return;
  }
  const chatKey = chatKeyOf(msg);
  if (text.startsWith("/")) {
    await handleCommand(text, chatKey, chat, ctx);
    return;
  }
  await dispatch(msg, text, chatKey, ctx);
}

async function handleCommand(
  text: string,
  chatKey: string,
  chat: string,
  ctx: WhatsAppInboundContext,
): Promise<void> {
  const [verb, ...rest] = text.split(/\s+/);
  switch (verb) {
    case "/start":
    case "/help":
      await reply(ctx, chat, HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessionMap.get(chatKey).current;
      const busy = ctx.inflight.has(chatKey) ? " A turn is running." : "";
      await reply(
        ctx,
        chat,
        current ? `This chat is on session ${current}.${busy}` : "No session for this chat yet.",
      );
      return;
    }
    case "/model":
      await reply(
        ctx,
        chat,
        await runModelCommand(rest, {
          runtime: ctx.runtime,
          sessionId: ctx.sessionMap.get(chatKey).current,
          code: (t) => t,
        }),
      );
      return;
    case "/new": {
      const previous = ctx.sessionMap.get(chatKey).current;
      ctx.sessionMap.rotate(chatKey);
      if (previous && !ctx.inflight.has(chatKey)) ctx.releaseApprovalSession(previous);
      await reply(
        ctx,
        chat,
        previous
          ? `Started a new session. Previous session ${previous} archived.`
          : "Started a new session.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(chatKey);
      if (!controller) {
        await reply(ctx, chat, "No turn in progress in this chat.");
        return;
      }
      controller.abort();
      await reply(ctx, chat, "Cancelling the current turn...");
      return;
    }
    default:
      await reply(ctx, chat, `Unknown command: ${verb}. Try /help.`);
  }
}

async function dispatch(
  msg: WhatsAppInbound,
  text: string,
  chatKey: string,
  ctx: WhatsAppInboundContext,
): Promise<void> {
  const chat = msg.chatJid;
  // A group has several speakers; a DM is one owner, already the chat key.
  const prompt = msg.isGroup ? `${formatWhatsAppSenderLine(msg)}\n${text}` : text;
  const session = acquireSession(msg, chatKey, ctx);
  ctx.ensureApprovalSession(session.id, chat);

  const controller = new AbortController();
  ctx.inflight.set(chatKey, controller);
  const stopTyping = startTyping(ctx, chat);

  let answer: string | null = null;
  let failure: { error: Error; category: string } | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (
      event.type === "llm_event" &&
      event.event.type === "assistant_reply" &&
      event.event.progressNote !== true
    ) {
      answer = event.event.text;
    }
    if (event.type === "loop_failed") failure = { error: event.error, category: event.category };
  };

  try {
    await ctx.runtime.runTurn(session, prompt, {
      origin: "whatsapp",
      signal: controller.signal,
      eventHook,
    });
  } catch (err) {
    failure = { error: err instanceof Error ? err : new Error(String(err)), category: "tool" };
  } finally {
    stopTyping();
    if (ctx.inflight.get(chatKey) === controller) ctx.inflight.delete(chatKey);
    releaseIfMovedOn(chatKey, session.id, ctx);
  }

  if (controller.signal.aborted) {
    await reply(ctx, chat, "Turn cancelled.");
  } else if (answer !== null) {
    await reply(ctx, chat, answer);
  } else if (failure !== null) {
    const f = failure as { error: Error; category: string };
    const detail = `${f.error.message}${describeFailedAttempts(f.error)}`;
    await reply(ctx, chat, `Turn failed (${f.category}): ${scrubWhatsAppError(detail)}`);
  } else {
    await reply(ctx, chat, "(no reply)");
  }
}

function acquireSession(
  msg: WhatsAppInbound,
  chatKey: string,
  ctx: WhatsAppInboundContext,
): SessionState {
  const current = ctx.sessionMap.get(chatKey).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("whatsapp: session map points at a missing session, starting a new one");
    ctx.releaseApprovalSession(current);
  }
  const label = msg.isGroup ? "group" : "DM";
  const fresh = ctx.runtime.createSession({
    metadata: { whatsappChannel: true, whatsappChat: { chatKey, label } },
  });
  ctx.sessionMap.setCurrent(chatKey, fresh.id, label);
  return fresh;
}

function releaseIfMovedOn(chatKey: string, sessionId: string, ctx: WhatsAppInboundContext): void {
  if (ctx.sessionMap.get(chatKey).current === sessionId) return;
  if (ctx.sessionMap.entries().some((e) => e.entry.current === sessionId)) return;
  ctx.releaseApprovalSession(sessionId);
}

/**
 * The `[from]` line for a group message, same shape as the other
 * channels. The display name is attacker-chosen text and goes through
 * `sanitizeDisplayName`. The user id prefers the privacy id (`@lid`)
 * over the phone number, since the prompt may go to a cloud provider.
 */
export function formatWhatsAppSenderLine(msg: Pick<WhatsAppInbound, "senderIds" | "senderName">): string {
  const parts = ["[from]"];
  const name = sanitizeDisplayName(msg.senderName ?? undefined);
  if (name !== undefined) parts.push(`name="${name}"`);
  parts.push("platform=whatsapp");
  const preferred = msg.senderIds.find((id) => id.endsWith("@lid")) ?? msg.senderIds[0];
  const user = (preferred ?? "").replace(/[^A-Za-z0-9@._-]/g, "").slice(0, 64);
  if (user.length > 0) parts.push(`user=${user}`);
  return parts.join(" ");
}

/** Show "typing..." for the turn; returns the stop function. Best-effort. */
function startTyping(ctx: WhatsAppInboundContext, chat: string): () => void {
  const sendTyping = ctx.sendTyping;
  if (!sendTyping) return () => {};
  const ping = (on: boolean): void => {
    void sendTyping(chat, on).catch(() => {
      // Cosmetic: a failed typing notice must never affect the turn.
    });
  };
  ping(true);
  const timer = setInterval(() => ping(true), TYPING_REFRESH_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    ping(false);
  };
}

/** Chunked send that never throws: a failed post must not kill the turn. */
async function reply(ctx: WhatsAppInboundContext, chat: string, text: string): Promise<void> {
  for (const chunk of chunkMessage(text, WHATSAPP_MESSAGE_LIMIT)) {
    try {
      await ctx.send(chat, chunk);
    } catch (err) {
      ctx.logger.warn("whatsapp: outbound send failed", { error: scrubWhatsAppError(err) });
      return;
    }
  }
}
