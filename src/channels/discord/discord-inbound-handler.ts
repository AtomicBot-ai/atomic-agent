/**
 * Inbound dispatch for the Discord channel: decide whether to drop a
 * message, answer it as a slash command, or run it through the agent.
 *
 * Mirrors `inbound-handler.ts` on the Telegram side, including its
 * hardest rule: **never throw past this boundary**, so one malformed
 * event can never take the gateway down.
 *
 * Every Discord channel (DM, guild channel, thread) is its own
 * conversation: the session map is keyed by `channel_id`, so asking
 * about project A in `#a` and project B in `#b` never mixes context.
 */

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DiscordApi } from "./discord-api.js";
import { scrubDiscordError } from "./discord-channel-types.js";
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
  /** Drop the approval binding for a session this channel left. */
  releaseApprovalSession?: (sessionId: string) => void;
  /** Pairing hook — consumes the message and returns true when claimed. */
  tryClaimForPairing?: (event: DiscordMessageEvent) => boolean;
  onMessageReceived?: () => void;
}

const HELP_TEXT = [
  "**atomic-agent — Discord remote control**",
  "",
  "DM me, or @mention me in a channel, and I'll act on it.",
  "Every channel (and thread) is its own conversation.",
  "",
  "Commands:",
  "  `/help` — this message",
  "  `/status` — this channel's session id",
  "  `/sessions` — every channel this bot has a session for",
  "  `/switch <session-id>` — point this channel at an existing session",
  "  `/new` — rotate this channel to a fresh session (current one is archived)",
  "  `/cancel` — abort this channel's current turn if one is running",
].join("\n");

/** Where a message came from, resolved once per event. */
interface ChannelRef {
  channelId: string;
  guildId: string | undefined;
  isDm: boolean;
  label: string;
}

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
  const ref: ChannelRef = {
    channelId: event.channel_id,
    guildId: event.guild_id,
    isDm,
    label: isDm ? "DM" : `channel ${event.channel_id}`,
  };
  // Resolve the pre-per-channel pointer before anything reads this
  // channel's entry, so `/status`, `/new` and `/switch` act on the real
  // session rather than on an empty entry the next text message would
  // then silently fill from `legacy`.
  adoptLegacyForDm(ref, ctx);
  if (text.startsWith("/")) {
    await handleSlashCommand(text, ref, ctx);
    return;
  }
  await dispatchToRuntime(text, ref, ctx);
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
  ref: ChannelRef,
  ctx: DiscordInboundContext,
): Promise<void> {
  const [verb, ...rest] = text.split(/\s+/);
  switch (verb) {
    case "/start":
    case "/help":
      await send(ctx, ref.channelId, HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessionPointer.get(ref.channelId).current;
      await send(
        ctx,
        ref.channelId,
        current
          ? `This channel is on session \`${current}\`.`
          : "No active session for this channel yet.",
      );
      return;
    }
    case "/sessions":
      await send(ctx, ref.channelId, formatSessions(ref, ctx));
      return;
    case "/switch":
      await switchSession(rest[0], ref, ctx);
      return;
    case "/new": {
      const previous = ctx.sessionPointer.get(ref.channelId).current;
      ctx.sessionPointer.rotate(ref.channelId);
      // A turn still running on the old session keeps its buttons until
      // it settles — `dispatchToRuntime` releases then.
      if (previous && !ctx.inflight.has(ref.channelId)) {
        ctx.releaseApprovalSession?.(previous);
      }
      await send(
        ctx,
        ref.channelId,
        previous
          ? `Started a new session for this channel. Previous session \`${previous}\` archived.`
          : "Started a new session for this channel.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(ref.channelId);
      if (!controller) {
        await send(ctx, ref.channelId, "No turn in progress in this channel.");
        return;
      }
      controller.abort();
      await send(ctx, ref.channelId, "Cancelling current turn…");
      return;
    }
    default:
      await send(ctx, ref.channelId, `Unknown command: ${verb}. Try \`/help\`.`);
  }
}

async function switchSession(
  sessionId: string | undefined,
  ref: ChannelRef,
  ctx: DiscordInboundContext,
): Promise<void> {
  if (!sessionId) {
    await send(
      ctx,
      ref.channelId,
      "Usage: `/switch <session-id>` — see `/sessions` for ids.",
    );
    return;
  }
  const current = ctx.sessionPointer.get(ref.channelId).current;
  if (current === sessionId) {
    await send(ctx, ref.channelId, `This channel is already on \`${sessionId}\`.`);
    return;
  }
  const session = ctx.runtime.sessionStore.load(sessionId);
  if (!session) {
    await send(ctx, ref.channelId, `Unknown session \`${sessionId}\`.`);
    return;
  }
  // Discord sessions only. The TUI's and Telegram's sessions live in the
  // same store; pulling one here would re-route its approvals to this
  // channel and interleave its turns with ours.
  if (session.metadata.discordChannel !== true) {
    await send(
      ctx,
      ref.channelId,
      `Session \`${sessionId}\` belongs to another surface (TUI or another channel); continue it there.`,
    );
    return;
  }
  // One session, one channel: two channels feeding the same session
  // would interleave their turns and bounce approval prompts around.
  const holder = ctx.sessionPointer
    .entries()
    .find((e) => e.chatKey !== ref.channelId && e.entry.current === sessionId);
  if (holder) {
    await send(
      ctx,
      ref.channelId,
      `Session \`${sessionId}\` is active in another channel (${holder.entry.label ?? holder.chatKey}). Run \`/new\` there first.`,
    );
    return;
  }
  if (ctx.runtime.turnController.isBusy(sessionId)) {
    await send(
      ctx,
      ref.channelId,
      `Session \`${sessionId}\` has a turn in progress; try again when it finishes.`,
    );
    return;
  }
  if (current && !ctx.inflight.has(ref.channelId)) {
    ctx.releaseApprovalSession?.(current);
  }
  ctx.sessionPointer.setCurrent(ref.channelId, sessionId, ref.label);
  await send(
    ctx,
    ref.channelId,
    current
      ? `This channel now continues session \`${sessionId}\`. Previous session \`${current}\` archived.`
      : `This channel now continues session \`${sessionId}\`.`,
  );
}

function formatSessions(ref: ChannelRef, ctx: DiscordInboundContext): string {
  const lines = ctx.sessionPointer
    .entries()
    .filter((e) => e.entry.current || (e.entry.history?.length ?? 0) > 0)
    .map((e) => {
      const here = e.chatKey === ref.channelId ? " (this channel)" : "";
      const where = e.entry.label === "DM" ? "DM" : `<#${e.chatKey}>`;
      const current = e.entry.current ? `\`${e.entry.current}\`` : "no active session";
      const archived = e.entry.history?.length ?? 0;
      const tail = archived > 0 ? `, ${archived} archived` : "";
      return `• ${where}${here}: ${current}${tail}`;
    });
  if (lines.length === 0) {
    return "No sessions yet — send a message to start one.";
  }
  return [
    "**Sessions by channel**",
    ...lines,
    "",
    "`/switch <session-id>` points this channel at one of them.",
  ].join("\n");
}

async function dispatchToRuntime(
  text: string,
  ref: ChannelRef,
  ctx: DiscordInboundContext,
): Promise<void> {
  const session = acquireOrCreateSession(ref, ctx);
  // Bind approvals before any step can request one, so a destructive
  // tool prompts in the Discord channel that asked for it rather than
  // on a TUI the requester cannot see.
  ctx.ensureApprovalSession?.(session.id, ref.channelId);

  const controller = new AbortController();
  ctx.inflight.set(ref.channelId, controller);

  let reply: string | null = null;
  let failure: { error: Error; category: LlmFailureCategory } | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event" && event.event.type === "assistant_reply") {
      reply = event.event.text;
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
    if (ctx.inflight.get(ref.channelId) === controller) {
      ctx.inflight.delete(ref.channelId);
    }
    releaseIfMovedOn(ref, session.id, ctx);
  }

  if (controller.signal.aborted) {
    await send(ctx, ref.channelId, "Turn cancelled.");
  } else if (reply !== null) {
    await send(ctx, ref.channelId, reply);
  } else if (failure) {
    await send(ctx, ref.channelId, formatFailure(failure));
  } else {
    await send(ctx, ref.channelId, "(no reply)");
  }
}

/**
 * The session this channel talks to. Order of preference: the channel's
 * own entry; the pre-per-channel v1 pointer (DMs only — the old shared
 * session was the owner's DM in practice); a fresh session stamped
 * with where it came from.
 */
function acquireOrCreateSession(
  ref: ChannelRef,
  ctx: DiscordInboundContext,
): SessionState {
  const current = ctx.sessionPointer.get(ref.channelId).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    // A pointer to a session that no longer exists (pruned store,
    // hand-edited file) must not wedge the channel -- start a new one.
    ctx.logger.warn("discord: pointer references missing session, recreating", {
      channelId: ref.channelId,
      sessionId: current,
    });
    // Nothing can ever request approval for a session that is gone.
    ctx.releaseApprovalSession?.(current);
  }
  const fresh = ctx.runtime.createSession({
    metadata: {
      discordChannel: true,
      discordChat: {
        channelId: ref.channelId,
        ...(ref.guildId === undefined ? {} : { guildId: ref.guildId }),
        label: ref.label,
      },
    },
  });
  ctx.sessionPointer.setCurrent(ref.channelId, fresh.id, ref.label);
  return fresh;
}

/**
 * Hand the pre-per-channel v1 pointer to the owner's DM the first time
 * the DM is heard from after the upgrade — whatever the message is.
 * Guild channels never inherit it: the old shared session was the DM
 * in practice.
 */
function adoptLegacyForDm(ref: ChannelRef, ctx: DiscordInboundContext): void {
  if (!ref.isDm) return;
  const adopted = ctx.sessionPointer.adoptLegacy(ref.channelId, ref.label);
  if (adopted) {
    ctx.logger.info("discord: adopted pre-per-channel session for DM", {
      channelId: ref.channelId,
      sessionId: adopted,
    });
  }
}

/**
 * After a turn settles: if the channel has meanwhile moved to another
 * session (`/new`, `/switch`) and no other channel picked this one up,
 * drop its approval binding. Deferred to here so a `/new` typed while
 * the turn was running never cut the buttons off from the turn.
 */
function releaseIfMovedOn(
  ref: ChannelRef,
  sessionId: string,
  ctx: DiscordInboundContext,
): void {
  if (ctx.sessionPointer.get(ref.channelId).current === sessionId) return;
  const heldElsewhere = ctx.sessionPointer
    .entries()
    .some((e) => e.entry.current === sessionId);
  if (heldElsewhere) return;
  ctx.releaseApprovalSession?.(sessionId);
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
