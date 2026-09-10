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
import {
  buildAttachmentUserMessage,
  formatBytes,
  type AttachmentInbox,
  type AttachmentOutcome,
} from "../attachments/inbox.js";
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
  /**
   * Files on the message. Discord delivers these (like `content`)
   * without the privileged intent for exactly the two cases this
   * channel acts on — a DM and an @mention.
   */
  attachments?: ReadonlyArray<DiscordAttachment>;
}

/** The subset of a Discord attachment object the channel reads. */
export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  /** Signed CDN URL; expires, so the download happens immediately. */
  url: string;
  content_type?: string;
}

export interface DiscordInboundContext {
  runtime: AgentRuntime;
  api: DiscordApi;
  sessionPointer: DiscordSessionPointer;
  logger: StructuredLogger;
  /** Snowflake of the sole permitted operator; `null` = unpaired. */
  ownerUserIds: readonly string[];
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
  /**
   * Where inbound files land — `<stateDir>/inbox/discord` in
   * production, a tmp dir in tests. The agent is told the saved path
   * and reads it with the ordinary fs / vision tools.
   */
  inbox: AttachmentInbox;
  /** Test seam — replaces the CDN fetch. Defaults to `fetch` with a timeout. */
  downloadAttachment?: (url: string) => Promise<Uint8Array>;
}

/**
 * Largest attachment the channel will pull off the CDN. Discord itself
 * allows far more with boosts and Nitro; this is a sanity cap for a
 * remote control, not a platform limit, and an oversized file is
 * reported in the chat rather than silently skipped.
 */
export const DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_FETCH_TIMEOUT_MS = 60_000;

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
  if (!ctx.ownerUserIds.includes(authorId)) {
    ctx.logger.warn("discord: dropping message from non-owner", {
      authorId,
      ownerConfigured: ctx.ownerUserIds.length > 0,
    });
    return;
  }

  ctx.onMessageReceived?.();
  const text = stripMention(
    typeof event.content === "string" ? event.content : "",
    ctx.botUserId,
  ).trim();
  // A message with files is a request about those files, even when
  // the text is empty or looks like a command — download first, then
  // run one turn that names every saved path.
  const attachments = event.attachments ?? [];
  if (text.length === 0 && attachments.length === 0) return;
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
  // A message with files is a request about those files, even when
  // the text is empty or looks like a command — download first, then
  // run one turn that names every saved path. It belongs to this
  // channel's session, exactly like a text message from here.
  if (attachments.length > 0) {
    await dispatchWithAttachments(text, attachments, ref, ctx);
    return;
  }
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
      await send(
        ctx,
        ref.channelId,
        `Unknown command: ${verb}. Try \`/help\`.`,
      );
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
    await send(
      ctx,
      ref.channelId,
      `This channel is already on \`${sessionId}\`.`,
    );
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
      const current = e.entry.current
        ? `\`${e.entry.current}\``
        : "no active session";
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

/**
 * Download every attachment (in parallel), tell the operator about the
 * ones that failed, then run the turn when there is anything for the
 * agent — at least one saved file or some text. A lone failed file
 * with no text ends at the notice.
 */
async function dispatchWithAttachments(
  text: string,
  attachments: ReadonlyArray<DiscordAttachment>,
  ref: ChannelRef,
  ctx: DiscordInboundContext,
): Promise<void> {
  const items = await Promise.all(
    attachments.map((attachment) => receiveAttachment(attachment, ctx)),
  );
  for (const item of items) {
    if (item.status === "failed") {
      await send(
        ctx,
        ref.channelId,
        `Could not receive ${item.name}: ${item.reason}`,
      );
    }
  }
  const anySaved = items.some((item) => item.status === "saved");
  if (!anySaved && text.length === 0) return;
  await dispatchToRuntime(buildAttachmentUserMessage(text, items), ref, ctx);
}

/**
 * Fetch + save one attachment. Never rejects: every failure is a
 * `failed` outcome with a scrubbed reason, so `Promise.all` over a
 * message's files cannot be taken down by one bad file.
 */
async function receiveAttachment(
  attachment: DiscordAttachment,
  ctx: DiscordInboundContext,
): Promise<AttachmentOutcome> {
  const name =
    typeof attachment.filename === "string" && attachment.filename.length > 0
      ? attachment.filename
      : "attachment";
  const tooBig = `over the ${formatBytes(DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES)} inbound limit`;
  if (
    typeof attachment.size === "number" &&
    attachment.size > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES
  ) {
    return { status: "failed", name, reason: tooBig };
  }
  if (typeof attachment.url !== "string" || attachment.url.length === 0) {
    return { status: "failed", name, reason: "Discord sent no download URL" };
  }
  try {
    const bytes = await (ctx.downloadAttachment ?? fetchAttachment)(
      attachment.url,
    );
    if (bytes.byteLength > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES) {
      return { status: "failed", name, reason: tooBig };
    }
    const saved = await ctx.inbox.save({
      name,
      ...(typeof attachment.content_type === "string"
        ? { mimeType: attachment.content_type }
        : {}),
      bytes,
    });
    ctx.logger.info("discord: attachment saved", {
      path: saved.path,
      bytes: saved.bytes,
    });
    return { status: "saved", saved };
  } catch (err) {
    const reason = scrubDiscordError(err);
    ctx.logger.warn("discord: attachment not saved", { name, error: reason });
    return { status: "failed", name, reason };
  }
}

async function fetchAttachment(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Discord CDN returned HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
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
    if (ctx.inflight.get(ref.channelId) === controller) {
      ctx.inflight.delete(ref.channelId);
    }
    releaseIfMovedOn(ref, session.id, ctx);
  }

  if (controller.signal.aborted) {
    await send(ctx, ref.channelId, "Turn cancelled.");
  } else if (reply !== null) {
    await send(ctx, ref.channelId, reply);
    // Files follow the text, one message each. A file that could not
    // be delivered is announced in the channel — the operator asked
    // for the file, not for the sentence saying it was sent.
    if (replyAttachments.length > 0) {
      const delivery = await sendDiscordAttachments({
        api: ctx.api,
        channelId: ref.channelId,
        paths: replyAttachments,
        logger: ctx.logger,
      });
      for (const failed of delivery.failed) {
        await send(ctx, ref.channelId, formatDiscordAttachmentFailure(failed));
      }
    }
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
