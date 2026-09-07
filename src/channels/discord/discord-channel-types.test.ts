import { describe, expect, it } from "vitest";

import {
  DISCORD_INTENTS,
  FATAL_CLOSE_CODES,
  chunkMessage,
  describeCloseCode,
  resolveDiscordToken,
  scrubDiscordError,
} from "./discord-channel-types.js";

/**
 * Token-shaped, but assembled at runtime rather than written out as a
 * literal: a literal of the real shape trips GitHub's push protection
 * (and every other secret scanner) on a value that is pure fiction.
 */
const TOKEN = ["A".repeat(24), "GaBcDe", "z".repeat(30)].join(".");

describe("scrubDiscordError", () => {
  it("removes a token embedded in an error", () => {
    const msg = scrubDiscordError(
      new Error(`connect failed for wss://gateway?token=${TOKEN}`),
    );
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain("<token>");
  });

  it("leaves an ordinary message alone", () => {
    expect(scrubDiscordError(new Error("ECONNRESET"))).toBe("ECONNRESET");
  });
});

describe("resolveDiscordToken", () => {
  it("prefers an explicit token over the env", () => {
    expect(resolveDiscordToken("explicit", { DISCORD_BOT_TOKEN: "env" })).toBe(
      "explicit",
    );
  });

  it("reads the env when no explicit token is given", () => {
    expect(resolveDiscordToken(undefined, { DISCORD_BOT_TOKEN: " t " })).toBe(
      "t",
    );
  });

  it("treats a blank env value as unconfigured", () => {
    // A stray `DISCORD_BOT_TOKEN=` line must not read as a real token,
    // or the channel would try to connect and fail with a 401.
    expect(resolveDiscordToken(undefined, { DISCORD_BOT_TOKEN: "  " })).toBeNull();
    expect(resolveDiscordToken(undefined, {})).toBeNull();
  });

  it("honours an explicit null (channel told to run tokenless)", () => {
    expect(resolveDiscordToken(null, { DISCORD_BOT_TOKEN: "env" })).toBeNull();
  });
});

describe("DISCORD_INTENTS", () => {
  it("excludes the privileged MESSAGE_CONTENT intent", () => {
    // Requesting it would force the operator through Discord's
    // verification once the bot is in 100+ guilds, and would let the
    // bot read guild chatter it was never addressed in.
    expect(DISCORD_INTENTS & (1 << 15)).toBe(0);
  });

  it("covers guild messages and DMs", () => {
    expect(DISCORD_INTENTS & (1 << 9)).toBeTruthy();
    expect(DISCORD_INTENTS & (1 << 12)).toBeTruthy();
  });
});

describe("close codes", () => {
  it("treats a bad token and disallowed intents as fatal", () => {
    // Retrying these burns Discord's per-day session-start budget and
    // would fail identically forever.
    expect(FATAL_CLOSE_CODES.has(4004)).toBe(true);
    expect(FATAL_CLOSE_CODES.has(4014)).toBe(true);
  });

  it("treats an ordinary drop as retryable", () => {
    expect(FATAL_CLOSE_CODES.has(1006)).toBe(false);
    expect(FATAL_CLOSE_CODES.has(4000)).toBe(false);
  });

  it("explains the actionable codes", () => {
    expect(describeCloseCode(4004)).toMatch(/bot token/);
    expect(describeCloseCode(4014)).toMatch(/privileged intent/);
  });
});

describe("chunkMessage", () => {
  it("leaves a short message as one chunk", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("drops an empty message rather than posting a blank", () => {
    expect(chunkMessage("")).toEqual([]);
  });

  it("splits on a paragraph boundary when there is one", () => {
    const text = `${"a".repeat(1500)}\n\n${"b".repeat(1000)}`;
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(1500));
    expect(chunks[1]).toBe("b".repeat(1000));
  });

  it("hard-splits a single line with no break to fall back on", () => {
    const chunks = chunkMessage("x".repeat(4500));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("")).toBe("x".repeat(4500));
  });

  it("never emits a chunk over the limit", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    for (const c of chunkMessage(text)) {
      expect(c.length).toBeLessThanOrEqual(2000);
    }
  });
});
