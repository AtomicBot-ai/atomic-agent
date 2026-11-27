import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DiscordMessageCursor,
  RecentMessageIds,
  compareSnowflakes,
  cursorPathFor,
  snowflakeAtMs,
  snowflakeTimeMs,
} from "./discord-message-cursor.js";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-discord-cursor-"));
  dirs.push(dir);
  return join(dir, "discord-session-cursor.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cursorPathFor", () => {
  it("sits next to the session pointer", () => {
    expect(cursorPathFor("/s/discord-session.json")).toBe(
      "/s/discord-session-cursor.json",
    );
  });
});

describe("snowflake helpers", () => {
  it("round-trips a timestamp to millisecond precision", () => {
    const ms = Date.UTC(2026, 10, 27, 12, 0, 0);
    expect(snowflakeTimeMs(snowflakeAtMs(ms))).toBe(ms);
  });

  it("compares as numbers, not strings", () => {
    // "9" > "10" as strings; as snowflakes it is older.
    expect(compareSnowflakes("9", "10")).toBeLessThan(0);
    expect(compareSnowflakes("10", "10")).toBe(0);
  });
});

describe("DiscordMessageCursor", () => {
  it("creates an entry, persists it, and reads it back in a new process", () => {
    const path = tmpFile();
    const cursor = new DiscordMessageCursor(path, () => 5);
    cursor.advance("c1", "100", "g1");

    const reread = new DiscordMessageCursor(path);
    expect(reread.get("c1")).toEqual({
      lastMessageId: "100",
      guildId: "g1",
      updatedAt: 5,
    });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
    };
    expect(onDisk.version).toBe(1);
  });

  it("never moves backwards and keeps the guild id", () => {
    const path = tmpFile();
    const cursor = new DiscordMessageCursor(path);
    cursor.advance("c1", "200", "g1");
    cursor.advance("c1", "150");
    expect(cursor.get("c1")?.lastMessageId).toBe("200");
    cursor.advance("c1", "300");
    expect(new DiscordMessageCursor(path).get("c1")).toMatchObject({
      lastMessageId: "300",
      guildId: "g1",
    });
  });

  it("ignores ids that are not snowflakes instead of throwing", () => {
    const cursor = new DiscordMessageCursor(tmpFile());
    expect(() => cursor.advance("c1", "m-1")).not.toThrow();
    expect(cursor.has("c1")).toBe(false);
  });

  it("reads a corrupt file as empty", () => {
    const path = tmpFile();
    writeFileSync(path, "{not json");
    expect(new DiscordMessageCursor(path).entries()).toEqual([]);
  });

  it("forget drops the channel from disk", () => {
    const path = tmpFile();
    const cursor = new DiscordMessageCursor(path);
    cursor.advance("c1", "1");
    cursor.forget("c1");
    expect(new DiscordMessageCursor(path).has("c1")).toBe(false);
  });
});

describe("RecentMessageIds", () => {
  it("claims an id once and forgets the oldest past the limit", () => {
    const ids = new RecentMessageIds(2);
    expect(ids.claim("a")).toBe(true);
    expect(ids.claim("a")).toBe(false);
    ids.claim("b");
    ids.claim("c");
    expect(ids.claim("a")).toBe(true);
  });
});
