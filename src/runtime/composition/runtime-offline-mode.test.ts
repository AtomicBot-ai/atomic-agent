import { afterEach, describe, expect, it, vi } from "vitest";

import { isOfflineNetwork, resetOfflineNetworkForTests, offlineRefusal } from "../../llm/offline-network.js";
import { ChannelRegistry } from "../../channels/channel-registry.js";
import type { Channel } from "../../channels/channel.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { OfflineModePersistError, createOfflineModeControl } from "./runtime-offline-mode.js";

function channel(id: string) {
  return {
    id,
    state: () => "up" as const,
    lastError: () => null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } satisfies Channel;
}

/** A real registry, the same class `runtime.channels` is. */
function registryOf(...channels: Channel[]): ChannelRegistry {
  const registry = new ChannelRegistry(new StructuredLogger({ level: "error", sinks: [] }));
  for (const c of channels) registry.register(c);
  return registry;
}

describe("runtime.offlineMode (ATO-1084)", () => {
  afterEach(() => resetOfflineNetworkForTests());

  it("persists, applies at once and stops the remote channels", async () => {
    const persist = vi.fn();
    const telegram = channel("telegram");
    const discord = channel("discord");
    const swarm = { startEnabled: vi.fn(async () => {}), stopAll: vi.fn(async () => {}) };
    const registry = registryOf(telegram, discord);
    const control = createOfflineModeControl({
      persist,
      channels: () => ({ registry, swarm }),
      channelEnabled: (id) => id === "telegram",
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
    const telegram = { ...channel("telegram"), stop: vi.fn(async () => { throw new Error("busy"); }) };
    const slack = channel("slack");
    const control = createOfflineModeControl({
      persist: () => {},
      channels: () => ({ registry: registryOf(telegram, slack), swarm: null }),
      warn,
    });
    await control.setEnabled(true);
    expect(control.isEnabled()).toBe(true);
    expect(warn).toHaveBeenCalledWith("offline mode: telegram stop failed", expect.any(Error));
    expect(slack.stop).toHaveBeenCalled();
  });

  it("stays offline and stops the channels when the config cannot be saved", async () => {
    const telegram = channel("telegram");
    const control = createOfflineModeControl({
      persist: () => {
        throw new Error("ro");
      },
      channels: () => ({ registry: registryOf(telegram), swarm: null }),
    });
    await expect(control.setEnabled(true)).rejects.toBeInstanceOf(OfflineModePersistError);
    expect(isOfflineNetwork()).toBe(true);
    expect(control.isEnabled()).toBe(true);
    expect(telegram.stop).toHaveBeenCalled();
  });

  it("stays offline when turning it off cannot be saved", async () => {
    let fail = false;
    const control = createOfflineModeControl({
      persist: () => {
        if (fail) throw new Error("ro");
      },
      channels: () => ({ registry: null, swarm: null }),
    });
    await control.setEnabled(true);
    fail = true;
    await expect(control.setEnabled(false)).rejects.toThrow("ro");
    expect(isOfflineNetwork()).toBe(true);
  });

  it("stops and restarts every registered channel, not a fixed list (ATO-1169 adapters)", async () => {
    // Whatever the registry holds is covered: the primaries and any
    // catalog adapter, including ids this file has never heard of.
    const registry = registryOf(
      channel("telegram"),
      channel("discord"),
      channel("slack"),
      channel("signal"),
      channel("some-future-messenger"),
    );
    const enabled = new Set(["discord", "slack", "some-future-messenger"]);
    const control = createOfflineModeControl({
      persist: () => {},
      channels: () => ({ registry, swarm: null }),
      channelEnabled: (id) => enabled.has(id),
    });
    const registered = registry.list() as ReturnType<typeof channel>[];
    expect(registered).toHaveLength(5);

    await control.setEnabled(true);
    for (const c of registered) expect(c.stop, `${c.id} stopped`).toHaveBeenCalledTimes(1);

    // While offline nothing in the registry may start, whoever asks.
    registry.startInBackground(registered.map((c) => c.id));
    await Promise.resolve();
    for (const c of registered) expect(c.start, `${c.id} held`).not.toHaveBeenCalled();

    await control.setEnabled(false);
    for (const c of registered) {
      expect(c.start, `${c.id} restarted`).toHaveBeenCalledTimes(enabled.has(c.id) ? 1 : 0);
    }
  });
});
