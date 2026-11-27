import { describe, expect, it } from "vitest";

import { formatChannelLockHeld } from "../channels/channel-lock-error.js";

import { createTelegramChannelHandler, otherPollerOf } from "./route-telegram-channel.js";

function call(runtime: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      writeHead: (s: number) => { status = s; return res; },
      end: (data?: string) => resolve({ status: status || res.statusCode, body: data ? JSON.parse(data) : {} }),
    };
    void createTelegramChannelHandler()({} as never, res as never, { runtime } as never);
  });
}

describe("GET /api/telegram/channel bot identity (ATO-2520)", () => {
  it("names the bot from getMe, and only its id and @username", async () => {
    const channel = {
      state: () => "up",
      lastError: () => null,
      getBotIdentity: () => ({ id: 7, username: "my_bot", canReadAllGroupMessages: false }),
    };
    const out = await call({ telegramChannel: channel });
    expect(out.body).toEqual({
      available: true,
      state: "up",
      lastError: null,
      bot: { id: 7, username: "my_bot" },
      otherPoller: null,
    });
  });

  it("answers bot: null before getMe, and on an agent without the channel", async () => {
    const channel = { state: () => "starting", lastError: () => null, getBotIdentity: () => null };
    expect((await call({ telegramChannel: channel })).body.bot).toBeNull();
    expect((await call({ telegramChannel: null })).body).toEqual({
      available: false,
      state: null,
      lastError: null,
      bot: null,
      otherPoller: null,
    });
  });
});

describe("otherPollerOf (ATO-758)", () => {
  it("names the other atomic-agent on this computer from the lock", () => {
    expect(otherPollerOf(formatChannelLockHeld(4242))).toEqual({ where: "this_computer", pid: 4242 });
  });

  it("reads Telegram's 409 as a poller somewhere else", () => {
    expect(otherPollerOf("getUpdates failed (409: Conflict: terminated by other getUpdates request)")).toEqual({
      where: "elsewhere",
    });
  });

  it("says nothing for other failures or none", () => {
    expect(otherPollerOf(null)).toBeNull();
    expect(otherPollerOf("getUpdates failed (401: Unauthorized)")).toBeNull();
  });
});
