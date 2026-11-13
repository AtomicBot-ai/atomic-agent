/**
 * Inbound dispatch for the Teams channel: drop, settle an approval,
 * answer a command, or run the message through the agent and reply in
 * the same conversation.
 *
 * Same hardest rule as the other channels: **never throw past this
 * boundary**, so one malformed activity cannot take the endpoint down.
 *
 * What reaches the agent: a `message` activity from a configured owner
 * (matched on `from.aadObjectId`), in a personal chat, or in a channel
 * or group chat only when it @mentions the bot. Each personal chat is
 * one conversation; in a channel each reply thread (Teams puts it in
 * `conversation.id` as `;messageid=`) is its own.
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { runModelCommand } from "../model-command.js";
import type { TeamsApi } from "./msteams-api.js";
import type { TeamsApprovalBridge } from "./msteams-approval-bridge.js";
import { scrubTeamsError, type TeamsActivity, type TeamsTarget } from "./msteams-types.js";

export interface TeamsInboundContext {
  runtime: AgentRuntime;
  api: Pick<TeamsApi, "postText">;
  sessions: Pick<ChatSessionMap, "get" | "setCurrent" | "rotate">;
  logger: StructuredLogger;
  /** AAD object ids allowed to drive the agent. Empty refuses everyone. */
  ownerIds: readonly string[];
  bridge: Pick<TeamsApprovalBridge, "handleSubmit" | "tryAnswer" | "pendingIn"> | null;
  /** `sessionKey -> AbortController` for the turn in flight. */
  inflight: Map<string, AbortController>;
  /** Recently handled `conversation:activity` keys, so a redelivery runs once. */
  seen: Set<string>;
  ensureApprovalSession?: (sessionId: string, target: TeamsTarget) => void;
  releaseApprovalSession?: (sessionId: string) => void;
}

const SEEN_CAP = 500;

const HELP_TEXT = [
  "**Atomic Agent on Microsoft Teams**",
  "Chat with me directly, or @mention me in a channel, and I'll act on it. Every chat and every channel thread is its own conversation.",
  "- `/status`: this conversation's session id",
  "- `/new`: start a fresh session here (the current one is archived)",
  "- `/model`: show the provider and model; `/model <provider> [model-id]` switches",
  "- `/cancel`: stop the turn running here",
].join("\n");

export interface TeamsRef {
  key: string;
  target: TeamsTarget;
  isPersonal: boolean;
  label: string;
}

/** Entry point for one authenticated activity. Always resolves; never throws. */
export async function handleTeamsActivity(activity: TeamsActivity, ctx: TeamsInboundContext): Promise<void> {
  try {
    await route(activity, ctx);
  } catch (err) {
    ctx.logger.warn("msteams: inbound handler failed", { error: scrubTeamsError(err) });
  }
}

async function route(activity: TeamsActivity, ctx: TeamsInboundContext): Promise<void> {
  if (activity.type !== "message") return;
  const conversationId = activity.conversation?.id;
  if (typeof conversationId !== "string" || typeof activity.serviceUrl !== "string") return;
  if (typeof activity.id !== "string") return;
  const botId = activity.recipient?.id;
  if (activity.from?.id !== undefined && activity.from.id === botId) return;

  const seenKey = `${conversationId}:${activity.id}`;
  if (ctx.seen.has(seenKey)) return;
  remember(ctx.seen, seenKey);

  const sender = activity.from?.aadObjectId;
  if (typeof sender !== "string" || !ctx.ownerIds.includes(sender)) {
    ctx.logger.warn("msteams: dropping message from non-owner", {
      aadObjectId: sender,
      ownerConfigured: ctx.ownerIds.length > 0,
    });
    return;
  }

  const ref = refOf(activity);
  // A card click carries no text and no mention.
  if (activity.value !== undefined && activity.value !== null && ctx.bridge) {
    const reply = await ctx.bridge.handleSubmit(activity.value, sender, conversationId);
    if (reply !== null) {
      if (reply.length > 0) await post(ctx, ref, reply);
      return;
    }
  }

  if (!ref.isPersonal && !mentionsBot(activity, botId)) return;
  const text = stripBotMention(activity, botId);
  if (text.length === 0) return;

  const answer = await ctx.bridge?.tryAnswer(conversationId, sender, text);
  if (answer !== null && answer !== undefined) {
    await post(ctx, ref, answer);
    return;
  }
  const command = /^\/([a-z]+)\b\s*(.*)$/is.exec(text);
  if (command && (await handleCommand(command[1]!.toLowerCase(), command[2] ?? "", ref, ctx))) return;
  await dispatchToRuntime(text, ref, ctx);
}

/** Session key and reply target for one activity. */
export function refOf(activity: TeamsActivity): TeamsRef {
  const conversationId = activity.conversation?.id ?? "";
  const type = activity.conversation?.conversationType ?? "personal";
  const isPersonal = type === "personal";
  return {
    key: conversationId,
    target: {
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      ...(!isPersonal && activity.id ? { replyToId: activity.id } : {}),
    },
    isPersonal,
    label: isPersonal ? "personal chat" : type === "channel" ? "channel thread" : "group chat",
  };
}

function botMentions(activity: TeamsActivity, botId: string | undefined) {
  return (activity.entities ?? []).filter(
    (e) => e.type === "mention" && botId !== undefined && e.mentioned?.id === botId,
  );
}

export function mentionsBot(activity: TeamsActivity, botId: string | undefined): boolean {
  return botMentions(activity, botId).length > 0;
}

/** The message text without the `<at>Bot</at>` that addressed us, entities decoded. */
export function stripBotMention(activity: TeamsActivity, botId: string | undefined): string {
  let text = activity.text ?? "";
  for (const m of botMentions(activity, botId)) {
    if (typeof m.text === "string" && m.text.length > 0) text = text.split(m.text).join(" ");
  }
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, (ws) => (ws.includes("\n") ? "\n" : " "))
    .trim();
}

async function handleCommand(verb: string, args: string, ref: TeamsRef, ctx: TeamsInboundContext): Promise<boolean> {
  switch (verb) {
    case "help":
    case "start":
      await post(ctx, ref, HELP_TEXT);
      return true;
    case "status": {
      const current = ctx.sessions.get(ref.key).current;
      const busy = ctx.inflight.has(ref.key) ? " A turn is running." : "";
      const open = ctx.bridge?.pendingIn(ref.key) ?? 0;
      const approvals = open > 0 ? ` ${open} approval${open === 1 ? "" : "s"} waiting.` : "";
      await post(ctx, ref, current ? `This conversation is on session \`${current}\`.${busy}${approvals}` : "No session here yet.");
      return true;
    }
    case "new": {
      const previous = ctx.sessions.get(ref.key).current;
      ctx.sessions.rotate(ref.key);
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

async function dispatchToRuntime(text: string, ref: TeamsRef, ctx: TeamsInboundContext): Promise<void> {
  if (ctx.inflight.has(ref.key)) {
    await post(ctx, ref, "A turn is already running here. Wait for it, or send `/cancel`.");
    return;
  }
  const session = acquireOrCreateSession(ref, ctx);
  // Bound before any step can ask, so a card lands in this conversation.
  ctx.ensureApprovalSession?.(session.id, ref.target);
  const controller = new AbortController();
  ctx.inflight.set(ref.key, controller);

  let reply: string | null = null;
  let files = 0;
  let failure: Error | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event" && event.event.type === "assistant_reply" && event.event.progressNote !== true) {
      reply = event.event.text;
      files = event.event.attachments?.length ?? 0;
    }
    if (event.type === "loop_failed") failure = event.error;
  };
  try {
    await ctx.runtime.runTurn(session, text, {
      origin: "msteams",
      // No Teams entry in `AnswerChannel` yet (shared type, follow-up):
      // a chat surface without tables or headings, ~3500 cap.
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
    await post(ctx, ref, reply);
    if (files > 0) {
      await post(ctx, ref, `${files === 1 ? "1 file" : `${files} files`} not sent: file upload to Teams is not supported yet.`);
    }
  } else if (failure !== null) {
    const err: Error = failure;
    await post(ctx, ref, `Turn failed: ${scrubTeamsError(`${err.message}${describeFailedAttempts(err)}`)}`);
  } else {
    await post(ctx, ref, "(no reply)");
  }
}

function acquireOrCreateSession(ref: TeamsRef, ctx: TeamsInboundContext): SessionState {
  const current = ctx.sessions.get(ref.key).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("msteams: pointer references missing session, recreating", { sessionId: current });
    ctx.releaseApprovalSession?.(current);
  }
  const fresh = ctx.runtime.createSession({
    metadata: {
      msteamsChannel: true,
      msteamsChat: { conversationId: ref.target.conversationId, label: ref.label },
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
async function post(ctx: TeamsInboundContext, ref: TeamsRef, text: string): Promise<void> {
  try {
    await ctx.api.postText(ref.target, text);
  } catch (err) {
    ctx.logger.warn("msteams: outbound post failed", { error: scrubTeamsError(err) });
  }
}
