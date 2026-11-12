/**
 * Inbound dispatch for the Slack channel: drop, answer a command, or run
 * the message through the agent and post the reply in the thread.
 *
 * Same hardest rule as Telegram and Discord: **never throw past this
 * boundary**, so one malformed event cannot take the socket down.
 *
 * What reaches the agent: a DM to the bot (`message` with
 * `channel_type: "im"`) or an @mention in a channel (`app_mention`),
 * from a configured owner, not from a bot, not an edit or other
 * subtype. Every DM is one conversation; in channels every thread is
 * its own conversation (with `threadReplies` off, top-level mentions in
 * one channel share one).
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { runModelCommand } from "../model-command.js";
import type { SlackApi } from "./slack-api.js";
import { markdownToSlack } from "./slack-format.js";
import { scrubSlackError, type SlackMessageEvent, type SlackTarget } from "./slack-types.js";

export interface SlackInboundContext {
  runtime: AgentRuntime;
  api: Pick<SlackApi, "postText">;
  sessions: Pick<ChatSessionMap, "get" | "setCurrent" | "rotate">;
  logger: StructuredLogger;
  /** Slack member ids allowed to drive the agent. Empty refuses everyone. */
  ownerIds: readonly string[];
  /** The bot's own member id (`auth.test` `user_id`). */
  botUserId: string;
  /** Reply in a thread under the triggering message (option `threadReplies`). */
  threadReplies: boolean;
  /** `sessionKey -> AbortController` for the turn in flight. */
  inflight: Map<string, AbortController>;
  /** Recently handled `channel:ts` keys, so a redelivered event runs once. */
  seen: Set<string>;
  ensureApprovalSession?: (sessionId: string, target: SlackTarget) => void;
  releaseApprovalSession?: (sessionId: string) => void;
}

/** How many handled message keys are remembered for de-duplication. */
const SEEN_CAP = 500;

const HELP_TEXT = [
  "*Atomic Agent on Slack*",
  "DM me, or @mention me in a channel, and I'll act on it. Every DM and every thread is its own conversation.",
  "Slack keeps `/` for its own commands, so type them with `!` (or after an @mention):",
  "• `!status`: this conversation's session id",
  "• `!new`: start a fresh session here (the current one is archived)",
  "• `!model`: show the provider and model; `!model <provider> [model-id]` switches",
  "• `!cancel`: stop the turn running here",
].join("\n");

/** Where one message came from and where its reply goes. */
export interface SlackRef {
  key: string;
  target: SlackTarget;
  isDm: boolean;
  label: string;
}

/** Entry point for one event. Always resolves; never throws. */
export async function handleSlackEvent(
  event: SlackMessageEvent,
  ctx: SlackInboundContext,
): Promise<void> {
  try {
    await route(event, ctx);
  } catch (err) {
    ctx.logger.warn("slack: inbound handler failed", { error: scrubSlackError(err) });
  }
}

async function route(event: SlackMessageEvent, ctx: SlackInboundContext): Promise<void> {
  const isDm = event.type === "message" && event.channel_type === "im";
  if (!isDm && event.type !== "app_mention") return;
  // Edits, joins, bot posts and our own replies all arrive as events too.
  if (event.subtype !== undefined || event.bot_id !== undefined) return;
  const user = event.user;
  if (typeof user !== "string" || user === ctx.botUserId) return;
  if (typeof event.channel !== "string" || typeof event.ts !== "string") return;

  const seenKey = `${event.channel}:${event.ts}`;
  if (ctx.seen.has(seenKey)) return;
  remember(ctx.seen, seenKey);

  if (!ctx.ownerIds.includes(user)) {
    ctx.logger.warn("slack: dropping message from non-owner", {
      userId: user,
      ownerConfigured: ctx.ownerIds.length > 0,
    });
    return;
  }

  const text = stripMention(event.text ?? "", ctx.botUserId).trim();
  if (text.length === 0) return;
  const ref = refOf(event, isDm, ctx.threadReplies);
  const command = /^[/!]([a-z]+)\b\s*(.*)$/is.exec(text);
  if (command && (await handleCommand(command[1]!.toLowerCase(), command[2] ?? "", ref, ctx))) return;
  await dispatchToRuntime(text, ref, ctx);
}

/** Session key and reply target for one event. */
export function refOf(event: SlackMessageEvent, isDm: boolean, threadReplies: boolean): SlackRef {
  const channel = event.channel ?? "";
  const root = event.thread_ts ?? event.ts ?? "";
  const threadTs = threadReplies ? root : event.thread_ts;
  const key = isDm
    ? `dm:${channel}`
    : threadReplies || event.thread_ts !== undefined
      ? `${channel}:${root}`
      : channel;
  return {
    key,
    target: { channel, ...(threadTs ? { threadTs } : {}) },
    isDm,
    label: isDm ? "DM" : `channel ${channel}`,
  };
}

/** Remove a leading `<@U…>` (optionally `<@U…|name>`) addressing the bot. */
export function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`^\\s*<@${botUserId}(\\|[^>]*)?>`), "");
}

/** Returns false for an unknown verb, so it goes to the agent as text. */
async function handleCommand(
  verb: string,
  args: string,
  ref: SlackRef,
  ctx: SlackInboundContext,
): Promise<boolean> {
  switch (verb) {
    case "help":
    case "start":
      await post(ctx, ref, HELP_TEXT);
      return true;
    case "status": {
      const current = ctx.sessions.get(ref.key).current;
      const busy = ctx.inflight.has(ref.key) ? " A turn is running." : "";
      await post(ctx, ref, current ? `This conversation is on session \`${current}\`.${busy}` : "No session here yet.");
      return true;
    }
    case "new": {
      const previous = ctx.sessions.get(ref.key).current;
      ctx.sessions.rotate(ref.key);
      // A turn still running keeps its buttons until it settles.
      if (previous && !ctx.inflight.has(ref.key)) ctx.releaseApprovalSession?.(previous);
      await post(ctx, ref, previous ? `Started a new session. Previous session \`${previous}\` archived.` : "Started a new session.");
      return true;
    }
    case "model":
      // Owner-gated already: `route` drops non-owners before this runs.
      await post(
        ctx,
        ref,
        await runModelCommand(args.split(/\s+/).filter((a) => a.length > 0), {
          runtime: ctx.runtime,
          sessionId: ctx.sessions.get(ref.key).current,
          code: (t) => `\`${t}\``,
        }),
      );
      return true;
    case "cancel": {
      const controller = ctx.inflight.get(ref.key);
      if (!controller) {
        await post(ctx, ref, "No turn in progress here.");
        return true;
      }
      controller.abort();
      await post(ctx, ref, "Cancelling the current turn…");
      return true;
    }
    default:
      return false;
  }
}

async function dispatchToRuntime(text: string, ref: SlackRef, ctx: SlackInboundContext): Promise<void> {
  const session = acquireOrCreateSession(ref, ctx);
  // Bound before any step can ask, so a prompt lands in this thread
  // rather than on a TUI the requester cannot see.
  ctx.ensureApprovalSession?.(session.id, ref.target);
  const controller = new AbortController();
  ctx.inflight.set(ref.key, controller);

  let reply: string | null = null;
  let files = 0;
  let failure: Error | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (
      event.type === "llm_event" &&
      event.event.type === "assistant_reply" &&
      event.event.progressNote !== true
    ) {
      reply = event.event.text;
      files = event.event.attachments?.length ?? 0;
    }
    if (event.type === "loop_failed") failure = event.error;
  };
  try {
    await ctx.runtime.runTurn(session, text, {
      origin: "slack",
      // No Slack entry in `AnswerChannel` yet (shared type, follow-up):
      // shaped for a chat surface without tables or headings, ~3500 cap.
      answerChannel: "telegram",
      signal: controller.signal,
      eventHook,
    });
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (ctx.inflight.get(ref.key) === controller) ctx.inflight.delete(ref.key);
    if (ctx.sessions.get(ref.key).current !== session.id) ctx.releaseApprovalSession?.(session.id);
  }

  if (controller.signal.aborted) {
    await post(ctx, ref, "Turn cancelled.");
  } else if (reply !== null) {
    await post(ctx, ref, markdownToSlack(reply));
    if (files > 0) {
      await post(ctx, ref, `${files === 1 ? "1 file" : `${files} files`} not sent: file upload to Slack is not supported yet.`);
    }
  } else if (failure !== null) {
    const err: Error = failure;
    await post(ctx, ref, `Turn failed: ${scrubSlackError(`${err.message}${describeFailedAttempts(err)}`)}`);
  } else {
    await post(ctx, ref, "(no reply)");
  }
}

function acquireOrCreateSession(ref: SlackRef, ctx: SlackInboundContext): SessionState {
  const current = ctx.sessions.get(ref.key).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("slack: pointer references missing session, recreating", { sessionId: current });
    ctx.releaseApprovalSession?.(current);
  }
  const fresh = ctx.runtime.createSession({
    metadata: {
      slackChannel: true,
      slackChat: {
        channel: ref.target.channel,
        ...(ref.target.threadTs ? { threadTs: ref.target.threadTs } : {}),
        label: ref.label,
      },
    },
  });
  ctx.sessions.setCurrent(ref.key, fresh.id, ref.label);
  return fresh;
}

function remember(seen: Set<string>, key: string): void {
  seen.add(key);
  if (seen.size <= SEEN_CAP) return;
  const oldest = seen.values().next().value;
  if (oldest !== undefined) seen.delete(oldest);
}

/** Post, swallowing transport errors: a failed post must not kill the turn. */
async function post(ctx: SlackInboundContext, ref: SlackRef, text: string): Promise<void> {
  try {
    await ctx.api.postText(ref.target, text);
  } catch (err) {
    ctx.logger.warn("slack: outbound post failed", { error: scrubSlackError(err) });
  }
}
