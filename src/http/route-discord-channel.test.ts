import { describe, expect, it } from "vitest";

import { formatChannelLockHeld } from "../channels/channel-lock-error.js";

import { createDiscordChannelHandler, discordOtherPollerOf } from "./route-discord-channel.js";

function call(runtime: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      writeHead: (s: number) => { status = s; return res; },
      end: (data?: string) => resolve({ status: status || res.statusCode, body: data ? JSON.parse(data) : {} }),
    };
    void createDiscordChannelHandler()({} as never, res as never, { runtime } as never);
  });
}

describe("GET /api/discord/channel (ATO-516)", () => {
  it("says the channel is missing on an agent without it", async () => {
    const out = await call({ discordChannel: null });
    expect(out.body).toEqual({ available: false, state: null, lastError: null, hasToken: false, bot: null, otherPoller: null });
  });

  it("reports the live state and the bot, never the token", async () => {
    const channel = {
      state: () => "up",
      lastError: () => null,
      hasToken: () => true,
      getBotIdentity: () => ({ id: "123456789012345678", username: "atomic_bot" }),
    };
    const out = await call({ discordChannel: channel });
    expect(out.body).toEqual({
      available: true,
      state: "up",
      lastError: null,
      hasToken: true,
      bot: { id: "123456789012345678", username: "atomic_bot" },
      otherPoller: null,
    });
    expect(JSON.stringify(out.body)).not.toMatch(/token":"/);
  });

  it("names the other atomic-agent that holds discord.lock", () => {
    expect(discordOtherPollerOf(formatChannelLockHeld(4242))).toEqual({ where: "this_computer", pid: 4242 });
    expect(discordOtherPollerOf("Discord gateway closed (4004: Authentication failed)")).toBeNull();
    expect(discordOtherPollerOf(null)).toBeNull();
  });
});
