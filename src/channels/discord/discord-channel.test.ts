import { describe, expect, it, vi } from "vitest";

import { DiscordChannel } from "./discord-channel.js";
import type { WebSocketLike } from "./discord-gateway-transport.js";

function makeChannel(over: Record<string, unknown> = {}) {
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const lock = { acquire: vi.fn(), release: vi.fn(), held: () => false };
  const channel = new DiscordChannel({
    runtime: { sessionStore: { load: () => null } } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    enabled: true,
    ownerUserId: "111",
    sessionPointerPath: "/tmp/does-not-matter.json",
    lock: lock as never,
    token: "a".repeat(24) + ".bbbbbb." + "c".repeat(30),
    onStatus: (s) => statuses.push(s),
    createSocket: (() => ({
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
    })) as unknown as (url: string) => WebSocketLike,
    ...over,
  });
  return { channel, statuses, lock };
}

describe("DiscordChannel", () => {
  it("stays disabled when the kill switch is off", async () => {
    const { channel, lock } = makeChannel({ enabled: false });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    // No lock is taken for a channel that never runs.
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it("reports a missing token as disabled, not down", async () => {
    // An unconfigured integration is a resting state; badging it as a
    // failure trains the operator to ignore a red badge.
    const { channel } = makeChannel({ token: null });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    expect(channel.lastError()).toBeNull();
  });

  it("goes down with a scrubbed reason when the lock is held", async () => {
    const { channel, statuses } = makeChannel({
      lock: {
        acquire: () => {
          throw new Error("another atomic-agent process (pid 42) is already running the Discord channel");
        },
        release: vi.fn(),
      },
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/already running/);
    expect(statuses.at(-1)?.state).toBe("down");
  });

  it("goes down and releases the lock when the token is rejected", async () => {
    const lock = { acquire: vi.fn(), release: vi.fn() };
    const { channel } = makeChannel({
      lock,
      apiBaseUrl: "https://discord.invalid/api/v10",
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/bot token/);
    // A held lock would block every later start attempt in this process.
    expect(lock.release).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never leaks the token into lastError", async () => {
    const token = "d".repeat(24) + ".eeeeee." + "f".repeat(30);
    const { channel } = makeChannel({ token, apiBaseUrl: "https://x.invalid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect failed using ${token}`);
      }),
    );
    await channel.start();
    expect(channel.lastError()).not.toContain(token);
    expect(channel.lastError()).toContain("<token>");
    vi.unstubAllGlobals();
  });

  it("stopping a disabled channel is a no-op", async () => {
    const { channel, lock } = makeChannel({ enabled: false });
    await channel.start();
    await channel.stop();
    expect(lock.release).not.toHaveBeenCalled();
  });
});
