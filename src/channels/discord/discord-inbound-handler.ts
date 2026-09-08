/**
 * Inbound dispatch for the Discord channel: decide whether to drop a
 * message, answer it as a slash command, or run it through the agent.
 *
 * Mirrors `inbound-handler.ts` on the Telegram side, including its
 * hardest rule: **never throw past this boundary**, so one malformed
 * event can never take the gateway down.
 */

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DiscordApi } from "./discord-api.js";
import { scrubDiscordError } from "./discord-channel-types.js";
import {
  formatDiscordAttachmentFailure,
  sendDiscordAttachments,
} from "./discord-outbound-attachments.js";
import type { DiscordSessionPointer } from "./discord-session-pointer.js";

/**
 * The subset of a Discord MESSAGE_CREATE payload this channel reads.
 * Declared structurally so tests can fabricate events without a
 * library type tree.
 */
export interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author?: { id: string; bot?: boolean; username?: string };
  mentions?: ReadonlyArray<{ id: string }>;
}

export interface DiscordInboundContext {
  runtime: AgentRuntime;
  api: DiscordApi;
  sessionPointer: DiscordSessionPointer;
  logger: StructuredLogger;
  /** Snowflake of the sole permitted operator; `null` = unpaired. */
  ownerUserId: string | null;
  /** The bot's own snowflake, for mention detection and self-filtering. */
  botUserId: string;
  /** `channelId -> AbortController` for the in-flight turn. */
  inflight: Map<string, AbortController>;
  /** Bind the approval router so prompts land in this Discord channel. */
  ensureApprovalSession?: (sessionId: string, channelId: string) => void;
  /** Pairing hook — consumes the message and returns true when claimed. */
  tryClaimForPairing?: (event: DiscordMessageEvent) => boolean;
  onMessageReceived?: () => void;
}

const HELP_TEXT = [
  "**atomic-agent — Discord remote control**",
  "",
  "DM me, or @mention me in a channel, and I'll act on it.",
  "",
  "Commands:",
  "  `/help` — this message",
  "  `/status` — active session id and counters",
  "  `/new` — rotate to a fresh session (current one is archived)",
  "  `/cancel` — abort the current turn if one is running",
].join("\n");

/**
 * Entry point for one MESSAGE_CREATE. Always returns; never throws.
 */
export async function handleDiscordMessage(
  event: DiscordMessageEvent,
  ctx: DiscordInboundContext,
): Promise<void> {
  try {
    await route(event, ctx);
  } catch (err) {
    ctx.logger.warn("discord: inbound handler failed", {
      error: scrubDiscordError(err),
    });
  }
}

async function route(
  event: DiscordMessageEvent,
  ctx: DiscordInboundContext,
): Promise<void> {
  const authorId = event.author?.id;
  if (typeof authorId !== "string") return;
  // Never react to our own posts, or to any other bot: two agents
  // wired to the same guild would otherwise talk to each other forever.
  if (authorId === ctx.botUserId || event.author?.bot === true) return;

  const isDm = event.guild_id === undefined;
  const mentionsBot =
    event.mentions?.some((m) => m.id === ctx.botUserId) === true;
  // In a guild the bot must be addressed explicitly. Without this the
  // agent would act on every message in any channel it can see.
  if (!isDm && !mentionsBot) return;

  // Pairing wins over the owner check — that is the whole point of a
  // pairing window: claim the first eligible message as the new owner.
  if (ctx.tryClaimForPairing?.(event)) {
    ctx.logger.info("discord: pairing claimed by inbound message", {
      authorId,
      channelId: event.channel_id,
    });
    return;
  }
  if (ctx.ownerUserId === null || authorId !== ctx.ownerUserId) {
    ctx.logger.warn("discord: dropping message from non-owner", {
      authorId,
      ownerConfigured: ctx.ownerUserId !== null,
    });
    return;
  }

  ctx.onMessageReceived?.();
  const text = stripMention(event.content, ctx.botUserId).trim();
  if (text.length === 0) return;
  if (text.startsWith("/")) {
    await handleSlashCommand(text, event.channel_id, ctx);
    return;
  }
  await dispatchToRuntime(text, event.channel_id, ctx);
}

/**
 * Remove a leading `<@id>` / `<@!id>` so the agent sees the request,
 * not the addressing. Only the leading mention goes: a mention inside
 * the sentence ("ask <@123> about it") is content.
 */
export function stripMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`^\\s*<@!?${botUserId}>`), "");
}

async function handleSlashCommand(
  text: string,
  channelId: string,
  ctx: DiscordInboundContext,
): Promise<void> {
  const [verb] = text.split(/\s+/, 1);
  switch (verb) {
    case "/start":
    case "/help":
      await send(ctx, channelId, HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessionPointer.read().current;
      await send(
        ctx,
        channelId,
        current ? `Session \`${current}\`.` : "No active session yet.",
      );
      return;
    }
    case "/new": {
      const previous = ctx.sessionPointer.read().current;
      ctx.sessionPointer.rotate();
      await send(
        ctx,
        channelId,
        previous
          ? `Started a new session. Previous session \`${previous}\` archived.`
          : "Started a new session.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(channelId);
      if (!controller) {
        await send(ctx, channelId, "No turn in progress.");
        return;
      }
      controller.abort();
      await send(ctx, channelId, "Cancelling current turn…");
      return;
    }
    default:
      await send(ctx, channelId, `Unknown command: ${verb}. Try \`/help\`.`);
  }
}

async function dispatchToRuntime(
  text: string,
  channelId: string,
  ctx: DiscordInboundContext,
): Promise<void> {
  const session = acquireOrCreateSession(ctx);
  // Bind approvals before any step can request one, so a destructive
  // tool prompts in the Discord channel that asked for it rather than
  // on a TUI the requester cannot see.
  ctx.ensureApprovalSession?.(session.id, channelId);

  const controller = new AbortController();
  ctx.inflight.set(channelId, controller);

  let reply: string | null = null;
  let replyAttachments: ReadonlyArray<string> = [];
  let failure: { error: Error; category: LlmFailureCategory } | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event" && event.event.type === "assistant_reply") {
      reply = event.event.text;
      replyAttachments = event.event.attachments ?? [];
    }
    if (event.type === "loop_failed") {
      failure = { error: event.error, category: event.category };
    }
  };

  try {
    await ctx.runtime.runTurn(session, text, {
      origin: "discord",
      signal: controller.signal,
      eventHook,
    });
  } catch (err) {
    failure = {
      error: err instanceof Error ? err : new Error(String(err)),
      category: "tool",
    };
  } finally {
    if (ctx.inflight.get(channelId) === controller) {
      ctx.inflight.delete(channelId);
    }
  }

  if (controller.signal.aborted) {
    await send(ctx, channelId, "Turn cancelled.");
  } else if (reply !== null) {
    await send(ctx, channelId, reply);
    // Files follow the text, one message each. A file that could not
    // be delivered is announced in the channel — the operator asked
    // for the file, not for the sentence saying it was sent.
    if (replyAttachments.length > 0) {
      const delivery = await sendDiscordAttachments({
        api: ctx.api,
        channelId,
        paths: replyAttachments,
        logger: ctx.logger,
      });
      for (const failed of delivery.failed) {
        await send(ctx, channelId, formatDiscordAttachmentFailure(failed));
      }
    }
  } else if (failure) {
    await send(ctx, channelId, formatFailure(failure));
  } else {
    await send(ctx, channelId, "(no reply)");
  }
}

function acquireOrCreateSession(ctx: DiscordInboundContext): SessionState {
  const current = ctx.sessionPointer.read().current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    // A pointer to a session that no longer exists (pruned store,
    // hand-edited file) must not wedge the channel -- start a new one.
    ctx.logger.warn("discord: pointer references missing session, recreating", {
      sessionId: current,
    });
  }
  const fresh = ctx.runtime.createSession({
    metadata: { discordChannel: true },
  });
  ctx.sessionPointer.set(fresh.id);
  return fresh;
}

function formatFailure(failure: {
  error: Error;
  category: LlmFailureCategory;
}): string {
  return `⚠️ Turn failed (${failure.category}): ${scrubDiscordError(failure.error)}`;
}

/** Send, swallowing transport errors — a failed post must not kill the turn. */
async function send(
  ctx: DiscordInboundContext,
  channelId: string,
  text: string,
): Promise<void> {
  try {
    await ctx.api.sendMessage(channelId, text);
  } catch (err) {
    ctx.logger.warn("discord: outbound send failed", {
      error: scrubDiscordError(err),
    });
  }
}
