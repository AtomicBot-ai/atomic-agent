import { describe, expect, it } from "vitest";

import { discordIntegration } from "./discord-integration.js";
import { DISCORD_BOT_TOKEN_KEY } from "../channels/discord/index.js";

const TOKEN = "botToken";
const OWNER = "ownerUserId";
/** Both fields are required, so "configured" needs both. */
const BOTH = [TOKEN, OWNER];
const VALID = `${"M".repeat(24)}.GaBcDe.${"z".repeat(30)}`;

function ctx(present: string[], channel?: string) {
  return {
    presentFields: new Set(present),
    configured: BOTH.every((f) => present.includes(f)),
    ...(channel === undefined
      ? {}
      : { channelStates: new Map([["discord", channel]]) }),
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
