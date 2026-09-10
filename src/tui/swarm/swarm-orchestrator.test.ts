import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { SwarmOrchestrator } from "./swarm-orchestrator.js";

vi.mock("../../config/index.js", () => ({
  getConfig: () => ({
    telegram: { enabled: true, ownerUserId: 42 },
    discord: { enabled: false, ownerUserIds: [] },
  }),
}));

function fakeBus() {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    emitted,
    emit: (a: unknown) => {
      emitted.push(a as Record<string, unknown>);
    },
    subscribe: () => () => undefined,
  };
}

function fakeRuntime(over: Partial<Record<string, unknown>> = {}) {
  const views = [
    {
      id: "ops",
      kind: "telegram",
      label: "Ops",
      role: "deploys",
      enabled: true,
      hasToken: true,
      ownerUserId: "42",
      state: "up",
      lastError: null,
      botUsername: "ops_bot",
      pairing: { active: false, expiresAt: null },
    },
  ];
  const listeners = new Set<() => void>();
  const swarm = {
    views: vi.fn(() => views),
    get: vi.fn((id: string) =>
      id === "ops"
        ? { config: { id, kind: "telegram", label: "Ops", enabled: true } }
        : undefined,
    ),
    add: vi.fn(async (input: { label: string }) => ({
      config: { label: input.label },
    })),
    update: vi.fn(async () => undefined),
    setToken: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    startPairing: vi.fn(async () => ({ claim: { userId: 777, chatId: 777 } })),
    cancelPairing: vi.fn(),
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fire: () => {
      for (const cb of listeners) cb();
    },
  };
  const telegramChannel = {
    getBotIdentity: () => ({ id: 1, username: "main_bot" }),
    pairingState: () => ({ active: false, expiresAt: null }),
    hasToken: () => true,
    state: () => "up",
    lastError: () => null,
  };
  const discordChannel = {
    getBotIdentity: () => null,
    hasToken: () => false,
    state: () => "disabled",
    lastError: () => null,
  };
  return {
    runtime: {
      swarm,
      telegramChannel,
      discordChannel,
      ...over,
    } as unknown as AgentRuntime,
    swarm,
  };
}

describe("SwarmOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds rows: primaries first, then units, with live state", () => {
    const bus = fakeBus();
    const { runtime } = fakeRuntime();
    const o = new SwarmOrchestrator(runtime, bus);
    o.refresh();
    const synced = bus.emitted.find((a) => a.type === "swarm_synced") as {
      rows: Array<Record<string, unknown>>;
    };
    expect(synced.rows.map((r) => r.id)).toEqual([
      "primary:telegram",
      "primary:discord",
      "ops",
    ]);
    expect(synced.rows[0]).toMatchObject({
      primary: true,
      ownerUserId: "42",
      botUsername: "main_bot",
      enabled: true,
    });
    expect(synced.rows[1]).toMatchObject({
      primary: true,
      hasToken: false,
      enabled: false,
    });
    expect(synced.rows[2]).toMatchObject({
      primary: false,
      label: "Ops",
      role: "deploys",
      state: "up",
    });
    o.dispose();
  });

  it("re-syncs when the registry reports a change", () => {
    const bus = fakeBus();
    const { runtime, swarm } = fakeRuntime();
    const o = new SwarmOrchestrator(runtime, bus);
    swarm.fire();
    expect(bus.emitted.filter((a) => a.type === "swarm_synced")).toHaveLength(
      1,
    );
    o.dispose();
    swarm.fire();
    expect(bus.emitted.filter((a) => a.type === "swarm_synced")).toHaveLength(
      1,
    );
  });

  it("add validates, forwards to the registry and reports the next step", async () => {
    const bus = fakeBus();
    const { runtime, swarm } = fakeRuntime();
    const o = new SwarmOrchestrator(runtime, bus);
    await o.add({
      kind: "telegram",
      label: "Ops",
      role: "",
      token: "",
      ownerUserId: "",
    });
    expect(swarm.add).toHaveBeenCalledWith({
      kind: "telegram",
      label: "Ops",
      role: "",
      token: null,
      ownerUserId: null,
    });
    expect(bus.emitted.at(-2)).toMatchObject({
      type: "swarm_action_settled",
      message: "Ops added — set its token with e",
    });
    await o.add({
      kind: "discord",
      label: "G",
      role: "",
      token: "t",
      ownerUserId: "abc",
    });
    expect(bus.emitted.at(-1)).toMatchObject({
      type: "swarm_action_settled",
      error: expect.stringContaining("numeric"),
    });
    o.dispose();
  });

  it("refuses to change the primaries and points at /integrations", async () => {
    const bus = fakeBus();
    const { runtime, swarm } = fakeRuntime();
    const o = new SwarmOrchestrator(runtime, bus);
    await o.toggle("primary:telegram");
    await o.remove("primary:discord");
    await o.saveField("primary:telegram", "label", "x");
    expect(swarm.update).not.toHaveBeenCalled();
    expect(swarm.remove).not.toHaveBeenCalled();
    for (const a of bus.emitted.filter(
      (e) => e.type === "swarm_action_settled",
    )) {
      expect(String(a.error)).toContain("/integrations");
    }
    o.dispose();
  });

  it("saves fields through the right registry call", async () => {
    const bus = fakeBus();
    const { runtime, swarm } = fakeRuntime();
    const o = new SwarmOrchestrator(runtime, bus);
    await o.saveField("ops", "role", "deploys");
    expect(swarm.update).toHaveBeenCalledWith("ops", { role: "deploys" });
    await o.saveField("ops", "owner", " 99 ");
    expect(swarm.update).toHaveBeenCalledWith("ops", { ownerUserId: "99" });
    await o.saveField("ops", "owner", "");
    expect(swarm.update).toHaveBeenCalledWith("ops", { ownerUserId: null });
    await o.saveField("ops", "token", "tok");
    expect(swarm.setToken).toHaveBeenCalledWith("ops", "tok");
    await o.toggle("ops");
    expect(swarm.update).toHaveBeenCalledWith("ops", { enabled: false });
    o.dispose();
  });

  it("refuses to pair a bot that is switched off instead of starting it silently", async () => {
    const bus = fakeBus();
    const { runtime, swarm } = fakeRuntime();
    swarm.get.mockReturnValue({
      config: { id: "ops", kind: "telegram", label: "Ops", enabled: false },
    });
    const o = new SwarmOrchestrator(runtime, bus);
    await o.pair("ops");
    expect(swarm.startPairing).not.toHaveBeenCalled();
    expect(bus.emitted.at(-1)).toMatchObject({
      type: "swarm_action_settled",
      error: "Ops is off — press enter to switch it on first",
    });
    o.dispose();
  });

  it("pairing reports the claim and ticks a countdown only while a window is open", async () => {
    const bus = fakeBus();
    const { runtime, swarm } = fakeRuntime();
    let active = false;
    swarm.views.mockImplementation(() => [
      {
        id: "ops",
        kind: "telegram",
        label: "Ops",
        role: "",
        enabled: true,
        hasToken: true,
        ownerUserId: null,
        state: "up",
        lastError: null,
        botUsername: null,
        pairing: { active, expiresAt: active ? Date.now() + 30_000 : null },
      },
    ]);
    const o = new SwarmOrchestrator(runtime, bus);
    active = true;
    o.refresh();
    const before = bus.emitted.filter((a) => a.type === "swarm_synced").length;
    vi.advanceTimersByTime(2_100);
    expect(
      bus.emitted.filter((a) => a.type === "swarm_synced").length,
    ).toBeGreaterThan(before);
    active = false;
    o.refresh();
    const settled = bus.emitted.filter((a) => a.type === "swarm_synced").length;
    vi.advanceTimersByTime(5_000);
    expect(bus.emitted.filter((a) => a.type === "swarm_synced").length).toBe(
      settled,
    );
    await o.pair("ops");
    expect(swarm.startPairing).toHaveBeenCalledWith("ops");
    expect(bus.emitted.at(-2)).toMatchObject({
      type: "swarm_action_settled",
      message: "Ops paired with user 777",
    });
    o.dispose();
  });
});
