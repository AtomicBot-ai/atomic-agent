/**
 * Inbound dispatch for the Signal channel (ATO-629): drop, answer an
 * approval, run a slash command, or run the message as an agent turn.
 *
 * Same hard rule as the Discord and Telegram handlers: **never throw
 * past this boundary**, so one odd envelope cannot stop the stream.
 *
 * Each DM partner and each group is its own conversation (chat key
 * `dm:<id>` / `group:<id>`). Only owners drive the agent; an empty
 * owner list refuses everyone. Groups are ignored unless the operator
 * set `allowGroups`, and even then only owner messages count.
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChannelContext } from "../channel.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { chunkMessage } from "../discord/discord-channel-types.js";
import { runModelCommand } from "../model-command.js";
import type { SignalApprovalBridge } from "./signal-approval-bridge.js";
import type { SignalTarget } from "./signal-rpc.js";
import { formatSignalSenderLine } from "./signal-sender-line.js";
import {
  SIGNAL_MESSAGE_LIMIT,
  chatKeyOf,
  scrubSignalError,
  toInbound,
  type SignalEnvelope,
  type SignalInbound,
} from "./signal-types.js";

/** Signal clears "typing…" after ~15 s; refresh a little sooner. */
const TYPING_REFRESH_MS = 10_000;

export interface SignalInboundContext {
  runtime: ChannelContext["runtime"];
  logger: StructuredLogger;
  sessionMap: ChatSessionMap;
  /** Normalized owner ids (E.164 numbers and/or UUIDs). Empty = refuse all. */
  ownerIds: readonly string[];
  /** The bot's own normalized number, to ignore our own echoes. */
  account: string;
  allowGroups: boolean;
  bridge: SignalApprovalBridge;
  send: (target: SignalTarget, text: string) => Promise<void>;
  sendTyping?: (target: SignalTarget, stop: boolean) => Promise<void>;
  /** `chatKey -> AbortController` for the turn running there. */
  inflight: Map<string, AbortController>;
  ensureApprovalSession: (sessionId: string, target: SignalTarget) => void;
  releaseApprovalSession: (sessionId: string) => void;
}

const HELP_TEXT = [
  "atomic-agent on Signal",
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

/** Entry point for one SSE payload's envelope. Always returns. */
export async function handleSignalEnvelope(
  envelope: SignalEnvelope,
  ctx: SignalInboundContext,
): Promise<void> {
  try {
    await route(envelope, ctx);
  } catch (err) {
    ctx.logger.warn("signal: inbound handler failed", { error: scrubSignalError(err) });
  }
}

async function route(envelope: SignalEnvelope, ctx: SignalInboundContext): Promise<void> {
  const msg = toInbound(envelope);
  if (msg === null) return;
  if (msg.senderIds.includes(ctx.account)) return;
  const isOwner = msg.senderIds.some((id) => ctx.ownerIds.includes(id));
  if (!isOwner) {
    // Ids are not logged: a phone number is personal data.
    ctx.logger.warn("signal: dropping message from non-owner", {
      ownerConfigured: ctx.ownerIds.length > 0,
      inGroup: msg.groupId !== null,
    });
    return;
  }
  if (msg.groupId !== null && !ctx.allowGroups) {
    ctx.logger.info("signal: ignoring group message (allowGroups is off)");
    return;
  }
  const target: SignalTarget =
    msg.groupId !== null ? { groupId: msg.groupId } : { recipient: msg.replyTo };
  const text = msg.text.trim();

  const answer = ctx.bridge.tryAnswer(text);
  if (answer !== null) {
    await reply(ctx, target, answer);
    return;
  }
  if (msg.attachmentCount > 0) {
    await reply(
      ctx,
      target,
      text.length > 0
        ? "Files are not supported on Signal yet; I only read the text."
        : "Files are not supported on Signal yet. Send the request as text.",
    );
    if (text.length === 0) return;
  }
  const chatKey = chatKeyOf(msg);
  if (text.startsWith("/")) {
    await handleCommand(text, chatKey, target, ctx);
    return;
  }
  await dispatch(msg, text, chatKey, target, ctx);
}

async function handleCommand(
  text: string,
  chatKey: string,
  target: SignalTarget,
  ctx: SignalInboundContext,
): Promise<void> {
  const [verb, ...rest] = text.split(/\s+/);
  switch (verb) {
    case "/start":
    case "/help":
      await reply(ctx, target, HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessionMap.get(chatKey).current;
      const busy = ctx.inflight.has(chatKey) ? " A turn is running." : "";
      await reply(
        ctx,
        target,
        current ? `This chat is on session ${current}.${busy}` : "No session for this chat yet.",
      );
      return;
    }
    case "/model":
      await reply(
        ctx,
        target,
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
        target,
        previous
          ? `Started a new session. Previous session ${previous} archived.`
          : "Started a new session.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(chatKey);
      if (!controller) {
        await reply(ctx, target, "No turn in progress in this chat.");
        return;
      }
      controller.abort();
      await reply(ctx, target, "Cancelling the current turn...");
      return;
    }
    default:
      await reply(ctx, target, `Unknown command: ${verb}. Try /help.`);
  }
}

async function dispatch(
  msg: SignalInbound,
  text: string,
  chatKey: string,
  target: SignalTarget,
  ctx: SignalInboundContext,
): Promise<void> {
  // A group has several speakers; a DM is one owner, already the chat key.
  const prompt =
    msg.groupId !== null ? `${formatSignalSenderLine(msg)}\n${text}` : text;
  const session = acquireSession(msg, chatKey, ctx);
  ctx.ensureApprovalSession(session.id, target);

  const controller = new AbortController();
  ctx.inflight.set(chatKey, controller);
  const stopTyping = startTyping(ctx, target);

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
      origin: "signal",
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
    await reply(ctx, target, "Turn cancelled.");
  } else if (answer !== null) {
    await reply(ctx, target, answer);
  } else if (failure !== null) {
    const f = failure as { error: Error; category: string };
    const detail = `${f.error.message}${describeFailedAttempts(f.error)}`;
    await reply(ctx, target, `Turn failed (${f.category}): ${scrubSignalError(detail)}`);
  } else {
    await reply(ctx, target, "(no reply)");
  }
}

function acquireSession(
  msg: SignalInbound,
  chatKey: string,
  ctx: SignalInboundContext,
): SessionState {
  const current = ctx.sessionMap.get(chatKey).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("signal: session map points at a missing session, starting a new one");
    ctx.releaseApprovalSession(current);
  }
  const label = msg.groupId !== null ? "group" : "DM";
  const fresh = ctx.runtime.createSession({
    metadata: { signalChannel: true, signalChat: { chatKey, label } },
  });
  ctx.sessionMap.setCurrent(chatKey, fresh.id, label);
  return fresh;
}

function releaseIfMovedOn(chatKey: string, sessionId: string, ctx: SignalInboundContext): void {
  if (ctx.sessionMap.get(chatKey).current === sessionId) return;
  if (ctx.sessionMap.entries().some((e) => e.entry.current === sessionId)) return;
  ctx.releaseApprovalSession(sessionId);
}

/** Show "typing…" for the turn; returns the stop function. Best-effort. */
function startTyping(ctx: SignalInboundContext, target: SignalTarget): () => void {
  const sendTyping = ctx.sendTyping;
  if (!sendTyping) return () => {};
  const ping = (stop: boolean): void => {
    void sendTyping(target, stop).catch(() => {
      // Cosmetic: a failed typing notice must never affect the turn.
    });
  };
  ping(false);
  const timer = setInterval(() => ping(false), TYPING_REFRESH_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    ping(true);
  };
}

/** Chunked send that never throws: a failed post must not kill the turn. */
async function reply(ctx: SignalInboundContext, target: SignalTarget, text: string): Promise<void> {
  for (const chunk of chunkMessage(text, SIGNAL_MESSAGE_LIMIT)) {
    try {
      await ctx.send(target, chunk);
    } catch (err) {
      ctx.logger.warn("signal: outbound send failed", { error: scrubSignalError(err) });
      return;
    }
  }
}
