import { describe, expect, it } from "vitest";

import { telegramIntegration } from "./telegram-integration.js";
import { TELEGRAM_BOT_TOKEN_KEY } from "../channels/telegram/index.js";

const TOKEN = "botToken";
const OWNER = "ownerUserId";
const BOTH = [TOKEN, OWNER];
const VALID = `123456789:${"A".repeat(35)}`;

function ctx(present: string[], channel?: string, error?: string) {
  return {
    presentFields: new Set(present),
    configured: BOTH.every((f) => present.includes(f)),
    ...(channel === undefined
      ? {}
      : { channelStates: new Map([["telegram", channel]]) }),
    ...(error === undefined
      ? {}
      : { channelErrors: new Map([["telegram", error]]) }),
  };
}

describe("telegramIntegration", () => {
  it("is the whole setup surface: token, owner and kill switch", () => {
    // The Telegram tab is gone, so anything it used to own has to be
    // reachable here or the operator has nowhere to go.
    const keys = telegramIntegration.fields.map((f) => f.key);
    expect(keys).toEqual([TOKEN, OWNER, "enabled"]);
    expect(telegramIntegration.fields[0]?.envVar).toBe(TELEGRAM_BOT_TOKEN_KEY);
    expect(telegramIntegration.fields[2]?.kind).toBe("boolean");
  });

  it("offers pairing and restart as actions", () => {
    const ids = (telegramIntegration.actions ?? []).map((a) => a.id);
    expect(ids).toEqual(["pair", "restart"]);
  });

  it("hides pairing and restart until a token exists", () => {
    // Pairing opens a window that claims the next DM; with no token
    // there is no bot to DM, so it could only ever time out.
    for (const action of telegramIntegration.actions ?? []) {
      expect(action.available?.(ctx([]))).toBe(false);
      expect(action.available?.(ctx([TOKEN]))).toBe(true);
    }
  });

  it("does not let an action key shadow edit or clear", () => {
    for (const action of telegramIntegration.actions ?? []) {
      expect(["e", "d", "j", "k"]).not.toContain(action.key);
    }
  });

  it("walks the operator through the setup states in order", () => {
    expect(telegramIntegration.status(ctx([])).level).toBe("not_configured");
    expect(telegramIntegration.status(ctx([TOKEN])).detail).toMatch(/press p to pair/);
    expect(telegramIntegration.status(ctx(BOTH)).detail).toMatch(/set Channel to on/);
    expect(telegramIntegration.status(ctx(BOTH, "up"))).toEqual({
      level: "connected",
      detail: "channel up",
    });
  });

  it("does not badge a disabled channel as an error", () => {
    expect(telegramIntegration.status(ctx(BOTH, "disabled")).level).toBe(
      "configured",
    );
    expect(telegramIntegration.status(ctx(BOTH, "down")).level).toBe("error");
  });

  it("rejects a token that is not BotFather-shaped", () => {
    const validate = telegramIntegration.fields[0]?.validate;
    expect(validate?.(VALID)).toBeUndefined();
    expect(validate?.("not-a-token")).toMatch(/bot token/);
    expect(validate?.("123456789:short")).toMatch(/bot token/);
  });

  it("applies live, because the hub can restart the channel itself", () => {
    expect(telegramIntegration.appliesLive).toBe(true);
  });
});

  it("shows the channel's own failure reason", () => {
    // "channel failed to start" told the operator nothing the badge did
    // not already say. The channel knows why -- a held lock, a rejected
    // token -- and that is the only part worth the screen space.
    const status = telegramIntegration.status(
      ctx(BOTH, "down", "another atomic-agent (pid 42) is already running the Telegram channel — stop it first"),
    );
    expect(status.detail).toMatch(/already running/);
  });

  it("falls back to a plain reason when the channel has none", () => {
    expect(telegramIntegration.status(ctx(BOTH, "down")).detail).toBe(
      "channel failed to start",
    );
  });
