/**
 * Inbound dispatch for the Google Chat channel: decide whether to drop
 * an event, answer it (approval, slash command, greeting), or run it
 * through the agent. Same hard rule as the other channels: **never
 * throw past this boundary**, so one malformed event cannot stop the
 * pull loop.
 *
 * Every space (DM or room) is its own conversation: the session map is
 * keyed by space name. Replies go into the thread of the message that
 * asked. Only owners' messages drive the agent; everyone else is
 * dropped without a reply.
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import type { GoogleChatApprovalBridge } from "./googlechat-approval-bridge.js";
import { GOOGLE_CHAT_HELP_TEXT, handleGoogleChatCommand } from "./googlechat-commands.js";
import {
  chunkGoogleChatText,
  googleChatRequestText,
  googleChatSenderLine,
  type GoogleChatEvent,
} from "./googlechat-events.js";
import { isSpaceName, isThreadName, scrubGoogleChatError, type GoogleChatUserRef } from "./googlechat-types.js";

export interface GoogleChatInboundContext {
  runtime: AgentRuntime;
  /** Post into `space`, in `thread` when given. May throw; callers swallow. */
  post: (space: string, text: string, thread?: string) => Promise<void>;
  sessions: Pick<ChatSessionMap, "get" | "setCurrent" | "rotate" | "entries">;
  logger: StructuredLogger;
  isOwner: (user: GoogleChatUserRef | undefined) => boolean;
  /** Is any owner configured? Logged on drops, to tell "unpaired" from "stranger". */
  ownerConfigured: boolean;
  /** `space -> AbortController` for the turn running there. */
  inflight: Map<string, AbortController>;
  bridge: Pick<GoogleChatApprovalBridge, "tryAnswer" | "pendingIn">;
  /** Bind the approval router so prompts land in this space. */
  ensureApprovalSession: (sessionId: string, space: string) => void;
  releaseApprovalSession: (sessionId: string) => void;
  /** Remember the thread of the latest owner message per space (approval prompts go there). */
  noteThread: (space: string, thread: string | undefined) => void;
}

/** Entry point for one decoded Chat event. Always returns; never throws. */
export async function handleGoogleChatEvent(
  event: GoogleChatEvent,
  ctx: GoogleChatInboundContext,
): Promise<void> {
  try {
    await route(event, ctx);
  } catch (err) {
    ctx.logger.warn("googlechat: inbound handler failed", { error: scrubGoogleChatError(err) });
  }
}

async function route(event: GoogleChatEvent, ctx: GoogleChatInboundContext): Promise<void> {
  const space = event.space?.name;
  if (!isSpaceName(space)) return;
  const user = event.user ?? event.message?.sender;
  // Never react to apps, ours or anyone else's: that is how bots loop.
  if (user?.type === "BOT") return;
  const isOwner = ctx.isOwner(user);

  if (event.type === "ADDED_TO_SPACE") {
    if (isOwner) await say(ctx, space, GOOGLE_CHAT_HELP_TEXT);
    else ctx.logger.warn("googlechat: added to a space by a non-owner", { space, userId: user?.name });
    // A space added with a message carries it in the same event; run it below.
    if (!event.message) return;
  } else if (event.type !== "MESSAGE") {
    // REMOVED_FROM_SPACE, CARD_CLICKED (we post no cards), anything newer.
    return;
  }

  if (!isOwner) {
    ctx.logger.warn("googlechat: dropping message from non-owner", {
      userId: user?.name,
      ownerConfigured: ctx.ownerConfigured,
    });
    return;
  }
  const rawThread = event.message?.thread?.name;
  const thread = isThreadName(rawThread) ? rawThread : undefined;
  ctx.noteThread(space, thread);

  if ((event.message?.attachment?.length ?? 0) > 0) {
    await say(ctx, space, "Files are not supported over Google Chat yet; send the request as text.", thread);
    return;
  }
  const text = googleChatRequestText(event);
  if (text.length === 0) return;

  const answer = ctx.bridge.tryAnswer(space, user, text);
  if (answer !== null) {
    await say(ctx, space, answer, thread);
    return;
  }
  if (text.startsWith("/")) {
    await handleGoogleChatCommand(text, space, {
      runtime: ctx.runtime,
      sessions: ctx.sessions,
      inflight: ctx.inflight,
      pendingApprovals: (id) => ctx.bridge.pendingIn(id),
      releaseApprovalSession: ctx.releaseApprovalSession,
      reply: (t) => say(ctx, space, t, thread),
    });
    return;
  }
  await dispatchToRuntime(`${googleChatSenderLine(user?.name, space)}\n${text}`, space, thread, ctx);
}

async function dispatchToRuntime(
  prompt: string,
  space: string,
  thread: string | undefined,
  ctx: GoogleChatInboundContext,
): Promise<void> {
  const session = acquireOrCreateSession(space, ctx);
  // Bind before any step can ask, so the prompt lands in this space
  // rather than on a TUI the requester cannot see.
  ctx.ensureApprovalSession(session.id, space);
  const controller = new AbortController();
  ctx.inflight.set(space, controller);

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
    await ctx.runtime.runTurn(session, prompt, {
      origin: "googlechat",
      signal: controller.signal,
      eventHook,
    });
  } catch (err) {
    failure = { error: err instanceof Error ? err : new Error(String(err)), category: "tool" };
  } finally {
    if (ctx.inflight.get(space) === controller) ctx.inflight.delete(space);
    releaseIfMovedOn(space, session.id, ctx);
  }

  if (controller.signal.aborted) {
    await say(ctx, space, "Turn cancelled.", thread);
  } else if (reply !== null) {
    for (const piece of chunkGoogleChatText(reply)) {
      if (!(await say(ctx, space, piece, thread))) break;
    }
    if (replyFiles.length > 0) {
      const names = replyFiles.map((p) => p.split(/[\\/]/).pop() ?? p).join(", ");
      await say(ctx, space, `Files are not sent over Google Chat yet; not delivered: ${names}`, thread);
    }
  } else if (failure) {
    await say(ctx, space, formatFailure(failure), thread);
  } else {
    await say(ctx, space, "(no reply)", thread);
  }
}

function acquireOrCreateSession(space: string, ctx: GoogleChatInboundContext): SessionState {
  const current = ctx.sessions.get(space).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("googlechat: pointer references missing session, recreating", {
      space,
      sessionId: current,
    });
    ctx.releaseApprovalSession(current);
  }
  const fresh = ctx.runtime.createSession({
    metadata: { googleChatChannel: true, googleChat: { space } },
  });
  ctx.sessions.setCurrent(space, fresh.id, space);
  return fresh;
}

/** After a turn: drop the binding if the space moved on (`/new`) and no space holds it. */
function releaseIfMovedOn(space: string, sessionId: string, ctx: GoogleChatInboundContext): void {
  if (ctx.sessions.get(space).current === sessionId) return;
  if (ctx.sessions.entries().some((e) => e.entry.current === sessionId)) return;
  ctx.releaseApprovalSession(sessionId);
}

function formatFailure(failure: { error: Error; category: LlmFailureCategory }): string {
  const text = `${failure.error.message}${describeFailedAttempts(failure.error)}`;
  return `Turn failed (${failure.category}): ${scrubGoogleChatError(text)}`;
}

/** Post, swallowing transport errors: a failed post must not kill the turn. */
async function say(
  ctx: GoogleChatInboundContext,
  space: string,
  text: string,
  thread?: string,
): Promise<boolean> {
  try {
    await ctx.post(space, text, thread);
    return true;
  } catch (err) {
    ctx.logger.warn("googlechat: outbound send failed", { error: scrubGoogleChatError(err) });
    return false;
  }
}
