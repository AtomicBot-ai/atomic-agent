import { describe, expect, it, vi } from "vitest";

import { RuntimeApiError } from "./runtime-api-error.js";
import {
  getTelegramStatus,
  pairTelegram,
  setTelegramEnabled,
  setTelegramToken,
  unpairTelegram,
  type TelegramChannelHandle,
  type TelegramServiceDeps,
} from "./telegram-service.js";

function makeChannel(
  overrides: Partial<TelegramChannelHandle> = {},
): TelegramChannelHandle {
  return {
    state: vi.fn(() => "up"),
    lastError: vi.fn(() => null),
    getOwnerUserId: vi.fn(() => 42),
    getBotIdentity: vi.fn(() => ({ id: 7, username: "bot" })),
    hasToken: vi.fn(() => true),
    setEnabled: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    setToken: vi.fn(async () => undefined),
    setOwnerUserId: vi.fn(async () => undefined),
    startPairing: vi.fn(async () => ({ userId: 99 })),
    cancelPairing: vi.fn(),
    ...overrides,
  };
}

describe("telegram-service facade", () => {
  it("snapshots status without leaking the token value", () => {
    const channel = makeChannel();
    const deps: TelegramServiceDeps = { channel };
    const status = getTelegramStatus(deps);
    expect(status).toEqual({
      present: true,
      state: "up",
      hasToken: true,
      ownerUserId: 42,
      bot: { id: 7, username: "bot" },
      lastError: null,
    });
    expect(JSON.stringify(status)).not.toContain("token-value");
  });

  it("throws subsystem_disabled when no channel is present", () => {
    const deps: TelegramServiceDeps = { channel: null };
    expect(() => getTelegramStatus(deps)).toThrowError(RuntimeApiError);
    try {
      getTelegramStatus(deps);
    } catch (err) {
      expect((err as RuntimeApiError).code).toBe("subsystem_disabled");
    }
  });

  it("validates enabled is a boolean", async () => {
    const deps: TelegramServiceDeps = { channel: makeChannel() };
    await expect(
      setTelegramEnabled(deps, "yes" as unknown as boolean),
    ).rejects.toMatchObject({ code: "invalid_request", field: "enabled" });
  });

  it("passes the token through to the channel and returns fresh status", async () => {
    const channel = makeChannel();
    const deps: TelegramServiceDeps = { channel };
    await setTelegramToken(deps, "secret");
    expect(channel.setToken).toHaveBeenCalledWith("secret");
  });

  it("reports started=false when pairing is not allowed", async () => {
    const channel = makeChannel({ startPairing: vi.fn(async () => null) });
    const deps: TelegramServiceDeps = { channel };
    const result = await pairTelegram(deps, 1000);
    expect(result.started).toBe(false);
    expect(channel.startPairing).toHaveBeenCalledWith(1000);
  });

  it("cancels pairing", () => {
    const channel = makeChannel();
    const deps: TelegramServiceDeps = { channel };
    expect(unpairTelegram(deps)).toEqual({ ok: true });
    expect(channel.cancelPairing).toHaveBeenCalledOnce();
  });
});
