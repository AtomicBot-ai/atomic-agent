/**
 * Catch up on Discord messages missed while the agent was offline
 * (ATO-2248). Runs on every gateway READY, that is after a restart or
 * after a drop Discord would not let us RESUME (a resumed session gets
 * its missed events replayed by Discord itself).
 *
 * For every channel that has a cursor, read history after the cursor
 * through REST in pages of 100, oldest first, and hand each message to
 * the same inbound path a live MESSAGE_CREATE takes, one at a time, so
 * the owner gate, the mention rule and the bot/self filter apply
 * unchanged and turns run in the order they were sent. Bounded by an
 * age limit and two counts so a week away cannot start a hundred turns.
 *
 * Precedent: pi's Discord plugin (cursor per channel, history in pages
 * of 100 on a new gateway session) and OpenClaw's WhatsApp channel,
 * which answers messages sent while it was offline.
 */

import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { DiscordApiError, type DiscordApi } from "./discord-api.js";
import { scrubDiscordError } from "./discord-channel-types.js";
import type { DiscordMessageEvent } from "./discord-inbound-handler.js";
import {
  compareSnowflakes,
  isSnowflake,
  snowflakeAtMs,
  snowflakeTimeMs,
  type DiscordMessageCursor,
} from "./discord-message-cursor.js";

/** Messages older than this are never backfilled. */
export const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** REST pages read per channel (100 messages each). */
export const CATCH_UP_MAX_PAGES = 5;
/** Missed messages handed to the inbound path per channel. */
export const CATCH_UP_MAX_DELIVERED = 20;

export interface DiscordCatchUpDeps {
  api: Pick<DiscordApi, "listMessagesAfter">;
  cursor: DiscordMessageCursor;
  /** The live inbound path; resolves when the message is handled. */
  deliver: (event: DiscordMessageEvent) => Promise<void>;
  logger: Pick<StructuredLogger, "info" | "warn">;
  now?: () => number;
  maxAgeMs?: number;
  maxPages?: number;
  maxDelivered?: number;
}

export interface DiscordCatchUpResult {
  channels: number;
  delivered: number;
}

/** Catch up every known channel in parallel; never throws. */
export async function catchUpDiscordChannels(
  deps: DiscordCatchUpDeps,
): Promise<DiscordCatchUpResult> {
  const known = deps.cursor.entries();
  const counts = await Promise.all(
    known.map(({ channelId, entry }) =>
      catchUpChannel(channelId, entry.lastMessageId, entry.guildId, deps),
    ),
  );
  const delivered = counts.reduce((a, b) => a + b, 0);
  if (delivered > 0) {
    deps.logger.info("discord: caught up on missed messages", {
      channels: known.length,
      delivered,
    });
  }
  return { channels: known.length, delivered };
}

async function catchUpChannel(
  channelId: string,
  cursorId: string,
  guildId: string | undefined,
  deps: DiscordCatchUpDeps,
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const oldest = now - (deps.maxAgeMs ?? CATCH_UP_MAX_AGE_MS);
  const ageFloor = snowflakeAtMs(oldest);
  // Start at whichever is newer: the cursor, or the age limit. A cursor
  // from last month would otherwise page through a month of history.
  let after =
    compareSnowflakes(cursorId, ageFloor) >= 0 ? cursorId : ageFloor;
  const pending: DiscordMessageEvent[] = [];
  let newest: string | null = null;
  try {
    for (let page = 0; page < (deps.maxPages ?? CATCH_UP_MAX_PAGES); page++) {
      const batch = (await deps.api.listMessagesAfter(channelId, after, 100))
        .map((raw) => toEvent(raw, channelId, guildId))
        .filter((e): e is DiscordMessageEvent => e !== null)
        .sort((a, b) => compareSnowflakes(a.id, b.id));
      if (batch.length === 0) break;
      for (const event of batch) {
        if (compareSnowflakes(event.id, cursorId) <= 0) continue;
        if (snowflakeTimeMs(event.id) < oldest) continue;
        pending.push(event);
      }
      newest = batch[batch.length - 1]!.id;
      after = newest;
      if (batch.length < 100) break;
    }
  } catch (err) {
    deps.logger.warn("discord: catch-up history read failed", {
      channelId,
      error: scrubDiscordError(err),
    });
    // The channel is gone or the bot lost access: stop asking.
    if (
      err instanceof DiscordApiError &&
      (err.status === 403 || err.status === 404)
    ) {
      deps.cursor.forget(channelId);
      return 0;
    }
  }

  const limit = deps.maxDelivered ?? CATCH_UP_MAX_DELIVERED;
  // Keep the newest when over the cap: what was asked last matters most.
  const toDeliver = pending.slice(Math.max(0, pending.length - limit));
  if (pending.length > toDeliver.length) {
    deps.logger.warn("discord: catch-up skipped older missed messages", {
      channelId,
      skipped: pending.length - toDeliver.length,
    });
  }
  for (const event of toDeliver) {
    // Advance first: a crash in the middle of a turn must not run that
    // turn a second time on the next start.
    deps.cursor.advance(channelId, event.id, guildId);
    try {
      await deps.deliver(event);
    } catch (err) {
      deps.logger.warn("discord: catch-up delivery failed", {
        channelId,
        error: scrubDiscordError(err),
      });
    }
  }
  // Past everything read, not just what was delivered, so the next
  // catch-up does not page through the same bot replies again.
  if (newest !== null) deps.cursor.advance(channelId, newest, guildId);
  return toDeliver.length;
}

/**
 * A REST message as the inbound event the gateway would have sent.
 * REST omits `guild_id`, so the cursor's copy is put back: without it
 * a guild message would be treated as a DM and skip the mention rule.
 */
function toEvent(
  raw: Record<string, unknown>,
  channelId: string,
  guildId: string | undefined,
): DiscordMessageEvent | null {
  if (!isSnowflake(raw.id)) return null;
  const rest: Record<string, unknown> = { ...raw };
  delete rest.guild_id;
  return {
    ...(rest as unknown as DiscordMessageEvent),
    id: raw.id,
    channel_id: channelId,
    content: typeof raw.content === "string" ? raw.content : "",
    ...(guildId === undefined ? {} : { guild_id: guildId }),
  };
}
