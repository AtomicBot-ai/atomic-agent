/**
 * Last processed Discord message per channel (ATO-2248), stored next to
 * the session pointer at `<stateDir>/discord-session-cursor.json`.
 *
 * The cursor is what lets the channel catch up after a restart or a
 * gateway session that could not be resumed: on READY it reads each
 * known channel's history after its cursor. A channel gets a cursor the
 * first time a message from it passes the owner gate, so the bot never
 * backfills a channel nobody used it from.
 *
 * File shape (hand-editable, same robustness contract as the session
 * pointer: corrupt reads as empty, writes are tmp + rename):
 *
 *     {
 *       "version": 1,
 *       "channels": {
 *         "<channelId>": { "lastMessageId": "…", "guildId": "…", "updatedAt": 1 }
 *       }
 *     }
 *
 * `guildId` is kept because a REST message carries no `guild_id`: a
 * backfilled guild message must still meet the guild rules (mention
 * required), not the DM ones.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface DiscordCursorEntry {
  lastMessageId: string;
  /** Absent for a DM channel. */
  guildId?: string;
  updatedAt?: number;
}

const FILE_VERSION = 1;
/** Oldest entries go first past this many channels. */
const MAX_CHANNELS = 500;
/** Discord epoch (2015-01-01T00:00:00Z) in ms. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** `<stateDir>/discord-session.json` -> `<stateDir>/discord-session-cursor.json`. */
export function cursorPathFor(sessionPointerPath: string): string {
  return sessionPointerPath.endsWith(".json")
    ? `${sessionPointerPath.slice(0, -".json".length)}-cursor.json`
    : `${sessionPointerPath}-cursor.json`;
}

export function isSnowflake(id: unknown): id is string {
  return typeof id === "string" && /^\d{1,20}$/.test(id);
}

/** Negative when `a` is older than `b`. Both must be snowflakes. */
export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** When Discord created the object with this id (ms since epoch). */
export function snowflakeTimeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** The smallest snowflake created at `ms`; a valid `after=` bound. */
export function snowflakeAtMs(ms: number): string {
  const sinceEpoch = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH_MS;
  return (sinceEpoch > 0n ? sinceEpoch << 22n : 0n).toString();
}

export class DiscordMessageCursor {
  private cache: Record<string, DiscordCursorEntry> | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(channelId: string): DiscordCursorEntry | undefined {
    return this.load()[channelId];
  }

  has(channelId: string): boolean {
    return this.get(channelId) !== undefined;
  }

  entries(): Array<{ channelId: string; entry: DiscordCursorEntry }> {
    return Object.entries(this.load()).map(([channelId, entry]) => ({
      channelId,
      entry,
    }));
  }

  /**
   * Move the channel's cursor to `messageId` when it is newer than the
   * stored one (creating the entry if needed). Never moves backwards
   * and never throws: a non-snowflake id is ignored.
   */
  advance(channelId: string, messageId: string, guildId?: string): void {
    if (!isSnowflake(messageId)) return;
    const chats = this.load();
    const existing = chats[channelId];
    if (
      existing &&
      compareSnowflakes(messageId, existing.lastMessageId) <= 0
    ) {
      return;
    }
    const kept = guildId ?? existing?.guildId;
    chats[channelId] = {
      lastMessageId: messageId,
      ...(kept === undefined ? {} : { guildId: kept }),
      updatedAt: this.now(),
    };
    this.write(chats);
  }

  /** Forget a channel (deleted, or the bot lost access). */
  forget(channelId: string): void {
    const chats = this.load();
    if (!(channelId in chats)) return;
    delete chats[channelId];
    this.write(chats);
  }

  private load(): Record<string, DiscordCursorEntry> {
    if (this.cache) return this.cache;
    this.cache = readCursorFile(this.path);
    return this.cache;
  }

  private write(chats: Record<string, DiscordCursorEntry>): void {
    const keys = Object.keys(chats);
    if (keys.length > MAX_CHANNELS) {
      keys
        .sort((a, b) => (chats[a]!.updatedAt ?? 0) - (chats[b]!.updatedAt ?? 0))
        .slice(0, keys.length - MAX_CHANNELS)
        .forEach((key) => delete chats[key]);
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      const payload = { version: FILE_VERSION, channels: chats };
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch {
      // A failed write only costs a catch-up after the next restart;
      // the in-memory cursor still dedupes this process.
    }
  }
}

function readCursorFile(path: string): Record<string, DiscordCursorEntry> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const channels = (parsed as { channels?: unknown } | null)?.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return {};
  }
  const out: Record<string, DiscordCursorEntry> = {};
  for (const [channelId, raw] of Object.entries(channels)) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || !isSnowflake(entry.lastMessageId)) continue;
    out[channelId] = {
      lastMessageId: entry.lastMessageId,
      ...(typeof entry.guildId === "string" ? { guildId: entry.guildId } : {}),
      ...(typeof entry.updatedAt === "number"
        ? { updatedAt: entry.updatedAt }
        : {}),
    };
  }
  return out;
}

/**
 * Ids this process already handed to the inbound path, so a message
 * that arrives both live and in a backfill (or twice through a gateway
 * replay) runs once. Bounded; the oldest id goes first.
 */
export class RecentMessageIds {
  private readonly ids = new Set<string>();

  constructor(private readonly limit = 1000) {}

  /** True the first time `id` is seen, false for a repeat. */
  claim(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}
