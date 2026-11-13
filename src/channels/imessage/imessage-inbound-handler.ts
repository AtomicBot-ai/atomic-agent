/**
 * Inbound dispatch for the iMessage channel: drop, answer a command or
 * an approval reply, or run the text through the agent.
 *
 * Same hard rule as the Telegram and Discord handlers: never throw past
 * this boundary, so one odd message cannot stop the watcher.
 *
 * Every Messages chat is its own conversation, keyed by the chat.db
 * chat rowid. Direct chats are answered by handle (`imsg send --to`),
 * group chats (only with `allowGroups`) by chat id.
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { runModelCommand } from "../model-command.js";
import type { ImessageApprovalBridge } from "./imessage-approval-bridge.js";
import { isOwnerHandle, maskHandle } from "./imessage-handle.js";
import type { ImsgMessage } from "./imsg-event.js";
import { scrubImessageError } from "./imsg-errors.js";
import type { ImessageTarget } from "./imsg-send.js";

export interface ImessageInboundContext {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  sessions: ChatSessionMap;
  /** Normalised owner handles, read per message so a change lands at once. */
  ownerIds: () => readonly string[];
  allowGroups: boolean;
  bridge: ImessageApprovalBridge;
  /** `chatKey -> AbortController` of the running turn. */
  inflight: Map<string, AbortController>;
  /** Send and swallow errors (the channel records them for `lastError`). */
  send: (target: ImessageTarget, text: string) => Promise<void>;
  ensureApprovalSession: (sessionId: string, chatId: number, target: ImessageTarget) => void;
  releaseApprovalSession: (sessionId: string) => void;
}

export const IMESSAGE_HELP_TEXT = [
  "atomic-agent over iMessage",
  "",
  "Text me and I'll act on it. Commands:",
  "/help: this message",
  "/status: this chat's session id",
  "/new: start a fresh session (the current one is archived)",
  "/model: show the model; /model <provider> [model-id] switches",
  "/cancel: stop the current turn",
  "",
  'Approvals: reply "yes <code>" or "no <code>" with the code from the prompt.',
].join("\n");

/** Entry point for one parsed message. Always resolves; never throws. */
export async function handleImessageMessage(
  message: ImsgMessage,
  ctx: ImessageInboundContext,
): Promise<void> {
  try {
    await route(message, ctx);
  } catch (err) {
    ctx.logger.warn("imessage: inbound handler failed", { error: scrubImessageError(err) });
  }
}

/** Where to answer a message: by handle in a direct chat, by chat id in a group. */
export function replyTarget(message: ImsgMessage): ImessageTarget {
  return message.isGroup || message.sender.length === 0
    ? { kind: "chat", chatId: message.chatId }
    : { kind: "handle", handle: message.sender };
}

async function route(message: ImsgMessage, ctx: ImessageInboundContext): Promise<void> {
  // Our own replies come back through the same chat.db stream; acting
  // on them would make the agent answer itself forever.
  if (message.isFromMe) return;
  if (message.isGroup && !ctx.allowGroups) {
    ctx.logger.info("imessage: ignoring group chat message", { chatId: message.chatId });
    return;
  }
  // Only iMessage authenticates the sender. With Text Message
  // Forwarding on, an SMS from a spoofed caller id would otherwise look
  // exactly like the owner's number and drive a shell on this Mac.
  if (message.service !== "iMessage") {
    ctx.logger.warn("imessage: dropping message not sent over iMessage", {
      service: message.service,
      sender: maskHandle(message.sender),
    });
    return;
  }
  if (!isOwnerHandle(message.sender, ctx.ownerIds())) {
    ctx.logger.warn("imessage: dropping message from non-owner", {
      sender: maskHandle(message.sender),
      ownerConfigured: ctx.ownerIds().length > 0,
    });
    return;
  }

  const target = replyTarget(message);
  const text = message.text.trim();
  if (text.length === 0) {
    if (message.attachmentCount > 0) {
      await ctx.send(target, "Files over iMessage are not supported yet. Send the request as text.");
    }
    return;
  }

  const approvalReply = ctx.bridge.handleReply(message.chatId, text);
  if (approvalReply !== null) {
    await ctx.send(target, approvalReply);
    return;
  }
  if (text.startsWith("/")) {
    await handleCommand(text, message, target, ctx);
    return;
  }
  await dispatchToRuntime(text, message, target, ctx);
}

async function handleCommand(
  text: string,
  message: ImsgMessage,
  target: ImessageTarget,
  ctx: ImessageInboundContext,
): Promise<void> {
  const chatKey = String(message.chatId);
  const [verb, ...rest] = text.split(/\s+/);
  switch ((verb ?? "").toLowerCase()) {
    case "/start":
    case "/help":
      await ctx.send(target, IMESSAGE_HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessions.get(chatKey).current;
      await ctx.send(target, current ? `This chat is on session ${current}.` : "No session for this chat yet.");
      return;
    }
    case "/model":
      await ctx.send(
        target,
        await runModelCommand(rest, {
          runtime: ctx.runtime,
          sessionId: ctx.sessions.get(chatKey).current,
          code: (t) => t,
        }),
      );
      return;
    case "/new": {
      const previous = ctx.sessions.get(chatKey).current;
      ctx.sessions.rotate(chatKey);
      // A turn still running keeps its approvals until it settles.
      if (previous && !ctx.inflight.has(chatKey)) ctx.releaseApprovalSession(previous);
      await ctx.send(
        target,
        previous ? `Started a new session. Previous session ${previous} archived.` : "Started a new session.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(chatKey);
      if (!controller) {
        await ctx.send(target, "No turn in progress.");
        return;
      }
      controller.abort();
      await ctx.send(target, "Cancelling the current turn…");
      return;
    }
    default:
      await ctx.send(target, `Unknown command ${verb}. Try /help.`);
  }
}

async function dispatchToRuntime(
  text: string,
  message: ImsgMessage,
  target: ImessageTarget,
  ctx: ImessageInboundContext,
): Promise<void> {
  const chatKey = String(message.chatId);
  const session = acquireOrCreateSession(message, ctx);
  // Bound before the turn starts, so a gated tool prompts on the phone
  // that asked rather than on a Mac screen nobody is looking at.
  ctx.ensureApprovalSession(session.id, message.chatId, target);

  const controller = new AbortController();
  ctx.inflight.set(chatKey, controller);
  let reply: string | null = null;
  let failure: string | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event" && event.event.type === "assistant_reply" && event.event.progressNote !== true) {
      reply = event.event.text;
    }
    if (event.type === "loop_failed") failure = `${event.category}: ${event.error.message}`;
  };
  try {
    await ctx.runtime.runTurn(session, text, { origin: "imessage", signal: controller.signal, eventHook });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    if (ctx.inflight.get(chatKey) === controller) ctx.inflight.delete(chatKey);
    if (ctx.sessions.get(chatKey).current !== session.id) ctx.releaseApprovalSession(session.id);
  }

  if (controller.signal.aborted) await ctx.send(target, "Turn cancelled.");
  else if (reply !== null) await ctx.send(target, reply);
  else if (failure !== null) await ctx.send(target, `Turn failed (${scrubImessageError(failure)})`);
  else await ctx.send(target, "(no reply)");
}

function acquireOrCreateSession(message: ImsgMessage, ctx: ImessageInboundContext): SessionState {
  const chatKey = String(message.chatId);
  const current = ctx.sessions.get(chatKey).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("imessage: pointer references missing session, recreating", { chatId: message.chatId });
    ctx.releaseApprovalSession(current);
  }
  const label = message.isGroup ? `group ${message.chatId}` : "direct";
  const fresh = ctx.runtime.createSession({
    // No phone number or e-mail in session metadata: it is persisted
    // and shown in session lists.
    metadata: { imessageChannel: true, imessageChat: { chatId: message.chatId, isGroup: message.isGroup } },
  });
  ctx.sessions.setCurrent(chatKey, fresh.id, label);
  return fresh;
}
