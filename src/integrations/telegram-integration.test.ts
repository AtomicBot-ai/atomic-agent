import { describe, expect, it } from "vitest";

import { telegramIntegration } from "./telegram-integration.js";
import { TELEGRAM_BOT_TOKEN_KEY } from "../channels/telegram/index.js";

const TOKEN = "botToken";
const VALID = `123456789:${"A".repeat(35)}`;

function ctx(present: string[], channel?: string) {
  return {
    presentFields: new Set(present),
    configured: present.includes(TOKEN),
    ...(channel === undefined
      ? {}
      : { channelStates: new Map([["telegram", channel]]) }),
  };
}

describe("telegramIntegration", () => {
  it("owns only the credential, and says where the rest lives", () => {
    // Pairing, owner id and start/stop stay on the Telegram tab; folding
    // a pairing countdown into a credential list would make both worse.
    expect(telegramIntegration.fields).toHaveLength(1);
    expect(telegramIntegration.fields[0]?.envVar).toBe(TELEGRAM_BOT_TOKEN_KEY);
    expect(telegramIntegration.summary).toMatch(/Telegram tab/);
  });

  it("reads an absent token as not configured", () => {
    expect(telegramIntegration.status(ctx([])).level).toBe("not_configured");
  });

  it("distinguishes a saved token from a running channel", () => {
    const saved = telegramIntegration.status(ctx([TOKEN]));
    expect(saved.level).toBe("configured");
    expect(saved.detail).toMatch(/pair and enable/);
    expect(telegramIntegration.status(ctx([TOKEN], "up"))).toEqual({
      level: "connected",
      detail: "channel up",
    });
  });

  it("does not badge a disabled channel as an error", () => {
    // A token saved with the channel off is a normal resting state.
    expect(telegramIntegration.status(ctx([TOKEN], "disabled")).level).toBe(
      "configured",
    );
    expect(telegramIntegration.status(ctx([TOKEN], "down")).level).toBe("error");
  });

  it("rejects a token that is not BotFather-shaped", () => {
    const validate = telegramIntegration.fields[0]?.validate;
    expect(validate?.(VALID)).toBeUndefined();
    expect(validate?.("not-a-token")).toMatch(/bot token/);
    // Right shape, secret too short -- the common truncated-paste case.
    expect(validate?.("123456789:short")).toMatch(/bot token/);
  });

  it("says changes need a restart", () => {
    // The channel resolves its token at construction, so a new token
    // does not take effect until the next boot -- the pane must say so.
    expect(telegramIntegration.appliesLive).toBe(false);
  });
});
