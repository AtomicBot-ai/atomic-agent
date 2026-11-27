import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordApiError } from "./discord-api.js";
import { catchUpDiscordChannels } from "./discord-catch-up.js";
import type { DiscordMessageEvent } from "./discord-inbound-handler.js";
import {
  DiscordMessageCursor,
  snowflakeAtMs,
} from "./discord-message-cursor.js";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** A snowflake `hoursAgo` before NOW, `k` apart so ids stay unique. */
function sf(hoursAgo: number, k = 0): string {
  return (BigInt(snowflakeAtMs(NOW - hoursAgo * HOUR)) + BigInt(k)).toString();
}

const dirs: string[] = [];
function cursorWith(
  entries: Record<string, { id: string; guildId?: string }>,
): { cursor: DiscordMessageCursor; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "atomic-discord-catchup-"));
  dirs.push(dir);
  const path = join(dir, "discord-session-cursor.json");
  const cursor = new DiscordMessageCursor(path, () => NOW);
  for (const [channelId, e] of Object.entries(entries)) {
    cursor.advance(channelId, e.id, e.guildId);
  }
  return { cursor, path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = { info: vi.fn(), warn: vi.fn() };

function raw(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, content, author: { id: "111" }, ...extra };
}

describe("catchUpDiscordChannels", () => {
  it("delivers the messages after the cursor oldest first and persists the cursor", async () => {
    const start = sf(2);
    const { cursor, path } = cursorWith({ c1: { id: start } });
    const first = sf(1, 1);
    const second = sf(1, 2);
    // Discord answers newest first.
    const listMessagesAfter = vi.fn(async () => [
      raw(second, "second"),
      raw(first, "first"),
    ]);
    const delivered: DiscordMessageEvent[] = [];

    const result = await catchUpDiscordChannels({
      api: { listMessagesAfter },
      cursor,
      logger,
      now: () => NOW,
      deliver: async (e) => {
        delivered.push(e);
      },
    });

    expect(delivered.map((e) => e.content)).toEqual(["first", "second"]);
    expect(delivered.every((e) => e.channel_id === "c1")).toBe(true);
    expect(listMessagesAfter).toHaveBeenCalledWith("c1", start, 100);
    expect(result).toEqual({ channels: 1, delivered: 2 });
    expect(new DiscordMessageCursor(path).get("c1")?.lastMessageId).toBe(
      second,
    );
  });

  it("does nothing for a channel without a cursor", async () => {
    const { cursor } = cursorWith({});
    const listMessagesAfter = vi.fn(async () => [raw(sf(1), "x")]);
    const deliver = vi.fn(async () => {});

    await catchUpDiscordChannels({
      api: { listMessagesAfter },
      cursor,
      logger,
      now: () => NOW,
      deliver,
    });

    expect(listMessagesAfter).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("skips messages older than the age limit and starts the read at it", async () => {
    const { cursor } = cursorWith({ c1: { id: sf(72) } });
    const stale = sf(30);
    const fresh = sf(1);
    const listMessagesAfter = vi.fn(async () => [
      raw(fresh, "fresh"),
      raw(stale, "stale"),
    ]);
    const delivered: string[] = [];

    await catchUpDiscordChannels({
      api: { listMessagesAfter },
      cursor,
      logger,
      now: () => NOW,
      deliver: async (e) => {
        delivered.push(e.content);
      },
    });

    expect(delivered).toEqual(["fresh"]);
    // A three-day-old cursor reads from the 24h floor, not from day one.
    expect(listMessagesAfter).toHaveBeenCalledWith("c1", sf(24), 100);
  });

  it("puts the guild id back so guild rules still apply", async () => {
    const { cursor } = cursorWith({ c1: { id: sf(2), guildId: "g1" } });
    const delivered: DiscordMessageEvent[] = [];

    await catchUpDiscordChannels({
      api: { listMessagesAfter: async () => [raw(sf(1), "hi")] },
      cursor,
      logger,
      now: () => NOW,
      deliver: async (e) => {
        delivered.push(e);
      },
    });

    expect(delivered[0]?.guild_id).toBe("g1");
  });

  it("pages after the newest id of a full page", async () => {
    const { cursor } = cursorWith({ c1: { id: sf(5) } });
    const page = Array.from({ length: 100 }, (_, i) => raw(sf(4, i), `m${i}`));
    const last = sf(4, 99);
    const listMessagesAfter = vi
      .fn()
      .mockResolvedValueOnce(page.slice().reverse())
      .mockResolvedValueOnce([raw(sf(3), "tail")]);

    await catchUpDiscordChannels({
      api: { listMessagesAfter },
      cursor,
      logger,
      now: () => NOW,
      maxDelivered: 500,
      deliver: async () => {},
    });

    expect(listMessagesAfter).toHaveBeenCalledTimes(2);
    expect(listMessagesAfter.mock.calls[1]).toEqual(["c1", last, 100]);
  });

  it("keeps only the newest messages past the cap but moves the cursor past all", async () => {
    const { cursor } = cursorWith({ c1: { id: sf(5) } });
    const ids = [sf(3, 1), sf(3, 2), sf(3, 3)];
    const delivered: string[] = [];

    await catchUpDiscordChannels({
      api: {
        listMessagesAfter: async () => ids.map((id, i) => raw(id, `m${i}`)),
      },
      cursor,
      logger,
      now: () => NOW,
      maxDelivered: 2,
      deliver: async (e) => {
        delivered.push(e.content);
      },
    });

    expect(delivered).toEqual(["m1", "m2"]);
    expect(cursor.get("c1")?.lastMessageId).toBe(ids[2]);
  });

  it("forgets a channel the bot can no longer read", async () => {
    const { cursor } = cursorWith({ c1: { id: sf(2) } });

    await catchUpDiscordChannels({
      api: {
        listMessagesAfter: async () => {
          throw new DiscordApiError("gone", 404);
        },
      },
      cursor,
      logger,
      now: () => NOW,
      deliver: async () => {},
    });

    expect(cursor.has("c1")).toBe(false);
  });
});
