import { afterEach, describe, expect, it, vi } from "vitest";

import { resetOfflineNetworkForTests, offlineRefusal } from "../../llm/offline-network.js";
import { createOfflineModeControl } from "./runtime-offline-mode.js";

function channel() {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
}

describe("runtime.offlineMode (ATO-1084)", () => {
  afterEach(() => resetOfflineNetworkForTests());

  it("persists, applies at once and stops the remote channels", async () => {
    const persist = vi.fn();
    const telegram = channel();
    const discord = channel();
    const swarm = { startEnabled: vi.fn(async () => {}), stopAll: vi.fn(async () => {}) };
    const control = createOfflineModeControl({
      persist,
      channels: () => ({ telegram, discord, swarm }),
      channelEnabled: () => ({ telegram: true, discord: false }),
    });
    expect(control.isEnabled()).toBe(false);

    await control.setEnabled(true);
    expect(persist).toHaveBeenCalledWith(true);
    expect(control.isEnabled()).toBe(true);
    expect(offlineRefusal("https://example.com/")).not.toBeNull();
    expect(control.egress().requestsBlocked).toBe(1);
    expect(telegram.stop).toHaveBeenCalled();
    expect(discord.stop).toHaveBeenCalled();
    expect(swarm.stopAll).toHaveBeenCalled();

    await control.setEnabled(false);
    expect(persist).toHaveBeenLastCalledWith(false);
    expect(control.isEnabled()).toBe(false);
    expect(telegram.start).toHaveBeenCalledTimes(1);
    expect(discord.start).not.toHaveBeenCalled();
    expect(swarm.startEnabled).toHaveBeenCalled();
  });

  it("keeps going when a channel fails to stop", async () => {
    const warn = vi.fn();
    const telegram = { start: vi.fn(async () => {}), stop: vi.fn(async () => { throw new Error("busy"); }) };
    const control = createOfflineModeControl({
      persist: () => {},
      channels: () => ({ telegram, discord: null, swarm: null }),
      warn,
    });
    await control.setEnabled(true);
    expect(control.isEnabled()).toBe(true);
    expect(warn).toHaveBeenCalledWith("offline mode: telegram stop failed", expect.any(Error));
  });
});
