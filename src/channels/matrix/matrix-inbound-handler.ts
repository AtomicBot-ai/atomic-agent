/**
 * Inbound dispatch for the Matrix channel: decide whether to drop a
 * room event, answer it (approval, slash command, notice), or run it
 * through the agent. Same hard rule as Discord and Telegram: **never
 * throw past this boundary**, so one malformed event cannot stop the
 * sync loop.
 *
 * Every room is its own conversation: the session map is keyed by
 * room id. The bot only joins rooms an owner invited it to, and only
 * owners' messages drive it.
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import type { MatrixApi, MatrixEvent } from "./matrix-api.js";
import type { MatrixApprovalBridge } from "./matrix-approval-bridge.js";
import { handleMatrixCommand } from "./matrix-commands.js";
import { matrixSenderLine, stripBotMention, stripReplyFallback } from "./matrix-text.js";
import {
  ENCRYPTED_NOTICE_INTERVAL_MS,
  ENCRYPTED_ROOM_NOTICE,
  scrubMatrixError,
} from "./matrix-types.js";

export interface MatrixInboundContext {
  runtime: AgentRuntime;
  api: Pick<MatrixApi, "sendMessage" | "sendNotice" | "setTyping">;
  sessions: Pick<ChatSessionMap, "get" | "setCurrent" | "rotate" | "entries">;
  logger: StructuredLogger;
  /** Mxids allowed to drive the agent. Empty = unpaired: refuse everything. */
  ownerIds: readonly string[];
  botUserId: string;
  /** `roomId -> AbortController` for the turn running there. */
  inflight: Map<string, AbortController>;
  bridge: Pick<MatrixApprovalBridge, "tryAnswer" | "pendingIn">;
  /** Bind the approval router so prompts land in this room. */
  ensureApprovalSession: (sessionId: string, roomId: string) => void;
  releaseApprovalSession: (sessionId: string) => void;
  /** `roomId -> last encrypted-room notice` (ms), owned by the channel. */
  encryptedNotices: Map<string, number>;
  now?: () => number;
  /** Typing refresh period; the server drops the flag after 30 s. */
  typingRefreshMs?: number;
}

const FILE_MSGTYPES = new Set(["m.image", "m.file", "m.audio", "m.video"]);

/** Entry point for one timeline event in `roomId`. Always returns; never throws. */
export async function handleMatrixEvent(
  roomId: string,
  event: MatrixEvent,
  ctx: MatrixInboundContext,
): Promise<void> {
  try {
    await route(roomId, event, ctx);
  } catch (err) {
    ctx.logger.warn("matrix: inbound handler failed", { error: scrubMatrixError(err) });
  }
}

async function route(roomId: string, event: MatrixEvent, ctx: MatrixInboundContext): Promise<void> {
  const sender = event.sender;
  // Never react to our own events: echoes of our replies come back in sync.
  if (typeof sender !== "string" || sender === ctx.botUserId) return;
  const isOwner = ctx.ownerIds.includes(sender);

  if (event.type === "m.room.encrypted") {
    if (isOwner) await noticeEncrypted(roomId, ctx);
    return;
  }
  if (event.type !== "m.room.message") return;
  const content = event.content ?? {};
  const msgtype = content.msgtype;
  // `m.notice` is the spec's "automated message": answering one is how
  // two bots end up talking to each other forever.
  if (msgtype === "m.notice") return;
  // An edit re-sends the whole text; running it again would repeat the turn.
  const relates = content["m.relates_to"] as { rel_type?: unknown } | undefined;
  if (relates?.rel_type === "m.replace") return;

  if (!isOwner) {
    ctx.logger.warn("matrix: dropping message from non-owner", {
      senderId: sender,
      ownerConfigured: ctx.ownerIds.length > 0,
    });
    return;
  }
  if (typeof msgtype === "string" && FILE_MSGTYPES.has(msgtype)) {
    await notice(ctx, roomId, "Files are not supported over Matrix yet; send the request as text.");
    return;
  }
  if (msgtype !== "m.text" && msgtype !== "m.emote") return;
  const raw = typeof content.body === "string" ? content.body : "";
  const text = stripBotMention(stripReplyFallback(raw, content), ctx.botUserId).trim();
  if (text.length === 0) return;

  const answer = ctx.bridge.tryAnswer(roomId, sender, text);
  if (answer !== null) {
    await notice(ctx, roomId, answer);
    return;
  }
  if (text.startsWith("/")) {
    await handleMatrixCommand(text, roomId, {
      runtime: ctx.runtime,
      sessions: ctx.sessions,
      inflight: ctx.inflight,
      pendingApprovals: (id) => ctx.bridge.pendingIn(id),
      releaseApprovalSession: ctx.releaseApprovalSession,
      reply: (t) => notice(ctx, roomId, t),
    });
    return;
  }
  await dispatchToRuntime(`${matrixSenderLine(sender, roomId)}\n${text}`, roomId, ctx);
}

async function noticeEncrypted(roomId: string, ctx: MatrixInboundContext): Promise<void> {
  const now = (ctx.now ?? Date.now)();
  const last = ctx.encryptedNotices.get(roomId);
  if (last !== undefined && now - last < ENCRYPTED_NOTICE_INTERVAL_MS) return;
  ctx.encryptedNotices.set(roomId, now);
  await notice(ctx, roomId, ENCRYPTED_ROOM_NOTICE);
}

async function dispatchToRuntime(
  prompt: string,
  roomId: string,
  ctx: MatrixInboundContext,
): Promise<void> {
  const session = acquireOrCreateSession(roomId, ctx);
  // Bind before any step can ask, so the prompt lands in this room
  // rather than on a TUI the requester cannot see.
  ctx.ensureApprovalSession(session.id, roomId);
  const controller = new AbortController();
  ctx.inflight.set(roomId, controller);
  const stopTyping = startTyping(roomId, ctx);

  let reply: string | null = null;
  let replyFiles: ReadonlyArray<string> = [];
  let failure: { error: Error; category: LlmFailureCategory } | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (
      event.type === "llm_event" &&
      event.event.type === "assistant_reply" &&
      event.event.progressNote !== true
    ) {
      reply = event.event.text;
      replyFiles = event.event.attachments ?? [];
    }
    if (event.type === "loop_failed") failure = { error: event.error, category: event.category };
  };

  try {
    // No `origin`: the runtime's origin list has no "matrix" entry yet,
    // and borrowing "discord" would give the reply Discord's style rules.
    await ctx.runtime.runTurn(session, prompt, { signal: controller.signal, eventHook });
  } catch (err) {
    failure = { error: err instanceof Error ? err : new Error(String(err)), category: "tool" };
  } finally {
    stopTyping();
    if (ctx.inflight.get(roomId) === controller) ctx.inflight.delete(roomId);
    releaseIfMovedOn(roomId, session.id, ctx);
  }

  if (controller.signal.aborted) {
    await notice(ctx, roomId, "Turn cancelled.");
  } else if (reply !== null) {
    await send(ctx, roomId, reply);
    if (replyFiles.length > 0) {
      const names = replyFiles.map((p) => p.split(/[\\/]/).pop() ?? p).join(", ");
      await notice(ctx, roomId, `Files are not sent over Matrix yet; not delivered: ${names}`);
    }
  } else if (failure) {
    await notice(ctx, roomId, formatFailure(failure));
  } else {
    await notice(ctx, roomId, "(no reply)");
  }
}

function acquireOrCreateSession(roomId: string, ctx: MatrixInboundContext): SessionState {
  const current = ctx.sessions.get(roomId).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("matrix: pointer references missing session, recreating", {
      roomId,
      sessionId: current,
    });
    ctx.releaseApprovalSession(current);
  }
  const fresh = ctx.runtime.createSession({
    metadata: { matrixChannel: true, matrixChat: { roomId } },
  });
  ctx.sessions.setCurrent(roomId, fresh.id, roomId);
  return fresh;
}

/** After a turn: drop the binding if the room moved on (`/new`) and no room holds it. */
function releaseIfMovedOn(roomId: string, sessionId: string, ctx: MatrixInboundContext): void {
  if (ctx.sessions.get(roomId).current === sessionId) return;
  if (ctx.sessions.entries().some((e) => e.entry.current === sessionId)) return;
  ctx.releaseApprovalSession(sessionId);
}

/** Typing indicator for the length of a turn, refreshed before the server drops it. */
function startTyping(roomId: string, ctx: MatrixInboundContext): () => void {
  const set = (typing: boolean): void => {
    void ctx.api.setTyping(roomId, ctx.botUserId, typing).catch(() => undefined);
  };
  set(true);
  const timer = setInterval(() => set(true), ctx.typingRefreshMs ?? 25_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    set(false);
  };
}

function formatFailure(failure: { error: Error; category: LlmFailureCategory }): string {
  const text = `${failure.error.message}${describeFailedAttempts(failure.error)}`;
  return `Turn failed (${failure.category}): ${scrubMatrixError(text)}`;
}

/** Send, swallowing transport errors: a failed post must not kill the turn. */
async function send(ctx: MatrixInboundContext, roomId: string, text: string): Promise<void> {
  try {
    await ctx.api.sendMessage(roomId, text);
  } catch (err) {
    ctx.logger.warn("matrix: outbound send failed", { error: scrubMatrixError(err) });
  }
}

async function notice(ctx: MatrixInboundContext, roomId: string, text: string): Promise<void> {
  try {
    await ctx.api.sendNotice(roomId, text);
  } catch (err) {
    ctx.logger.warn("matrix: outbound notice failed", { error: scrubMatrixError(err) });
  }
}
