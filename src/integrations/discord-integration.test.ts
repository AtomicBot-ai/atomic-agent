import { describe, expect, it } from "vitest";

import { formatChannelLockHeld } from "../channels/channel-lock-error.js";

import { discordIntegration } from "./discord-integration.js";
import { DISCORD_BOT_TOKEN_KEY } from "../channels/discord/index.js";

const TOKEN = "botToken";
const OWNER = "ownerUserId";
/** Both fields are required, so "configured" needs both. */
const BOTH = [TOKEN, OWNER];
const VALID = `${"M".repeat(24)}.GaBcDe.${"z".repeat(30)}`;

function ctx(present: string[], channel?: string, error?: string) {
  return {
    presentFields: new Set(present),
    configured: BOTH.every((f) => present.includes(f)),
    ...(channel === undefined
      ? {}
      : { channelStates: new Map([["discord", channel]]) }),
    ...(error === undefined
      ? {}
      : { channelErrors: new Map([["discord", error]]) }),
  };
}

describe("discordIntegration", () => {
  it("stores the bot token under the channel's env var", () => {
    expect(discordIntegration.fields[0]?.envVar).toBe(DISCORD_BOT_TOKEN_KEY);
    expect(discordIntegration.fields[0]?.secret).toBe(true);
  });

  it("reads an absent token as not configured", () => {
    expect(discordIntegration.status(ctx([])).level).toBe("not_configured");
  });

  it("separates saved, connecting, connected and failed", () => {
    expect(discordIntegration.status(ctx(BOTH)).level).toBe("configured");
    expect(discordIntegration.status(ctx(BOTH, "starting")).level).toBe(
      "configured",
    );
    expect(discordIntegration.status(ctx(BOTH, "up")).level).toBe(
      "connected",
    );
    expect(discordIntegration.status(ctx(BOTH, "down")).level).toBe("error");
  });

  it("does not badge a disabled channel as an error", () => {
    expect(discordIntegration.status(ctx(BOTH, "disabled")).level).toBe(
      "configured",
    );
  });

  it("rejects the client secret and public key from the same portal page", () => {
    // The most common paste mistake -- neither has the three-segment
    // shape, and both would otherwise fail as an opaque 401 at connect.
    const validate = discordIntegration.fields[0]?.validate;
    expect(validate?.(VALID)).toBeUndefined();
    expect(validate?.("Xy9_ThisLooksLikeAClientSecret123456")).toMatch(
      /client secret/,
    );
    expect(validate?.("a".repeat(64))).toMatch(/client secret/);
  });

  it("is not configured until the owner is paired too", () => {
    // A token with no owner would connect and then refuse every
    // message -- that is not "ready".
    expect(discordIntegration.status(ctx([TOKEN])).level).toBe(
      "not_configured",
    );
  });

  it("validates the owner id as a snowflake", () => {
    const validate = discordIntegration.fields[1]?.validate;
    expect(validate?.("123456789012345678")).toBeUndefined();
    expect(validate?.("nope")).toMatch(/Developer Mode/);
  });

  it("shows the channel's own failure reason, not a generic line", () => {
    // This used to read "gateway failed — see the Discord tab", which
    // was useless twice over: it told the operator nothing actionable,
    // and it pointed at a tab that does not exist.
    const status = discordIntegration.status(
      ctx(BOTH, "down", "another atomic-agent (pid 42) is already running the Discord channel — stop it first"),
    );
    expect(status.level).toBe("error");
    expect(status.detail).toMatch(/already running/);
    expect(status.detail).not.toMatch(/Discord tab/);
  });

  it("never points at a tab that does not exist", () => {
    for (const state of [undefined, "up", "down", "starting", "disabled"]) {
      const d = discordIntegration.status(ctx(BOTH, state)).detail ?? "";
      expect(d).not.toMatch(/Discord tab/);
    }
  });

  it("falls back to a plain reason when the channel has none", () => {
    expect(discordIntegration.status(ctx(BOTH, "down")).detail).toBe(
      "gateway failed",
    );
  });

  it("does not badge another running instance as an error", () => {
    // Running the bots in one terminal and the TUI in another is normal.
    // The channel here genuinely cannot start, but nothing is broken and
    // the bot is working -- red on a healthy system is red people learn
    // to ignore.
    const status = discordIntegration.status(
      ctx(BOTH, "down", formatChannelLockHeld(4242)),
    );
    expect(status.level).toBe("configured");
    expect(status.detail).toBe("already running in another atomic-agent (pid 4242)");
    expect(status.detail).not.toContain("channel-locked:");
  });

  it("still badges a genuine failure as an error", () => {
    const status = discordIntegration.status(ctx(BOTH, "down", "token rejected (HTTP 401)"));
    expect(status.level).toBe("error");
    expect(status.detail).toMatch(/401/);
  });
});
