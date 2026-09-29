import { describe, expect, it } from "vitest";

import {
  DaemonSupervisor,
  MAX_QUICK_DEATHS,
  QUICK_DEATH_MS,
  type DaemonSupervisorDeps,
} from "./daemon-supervisor.js";

function world(over: Partial<DaemonSupervisorDeps> = {}) {
  const state = {
    now: 1_000_000,
    alive: true,
    enabled: true,
    owns: true,
    restarts: 0,
    restartResult: true,
    lines: [] as string[],
  };
  const deps: DaemonSupervisorDeps = {
    enabled: () => state.enabled,
    owns: () => state.owns,
    pidAlive: async () => state.alive,
    restart: async () => {
      state.restarts += 1;
      if (state.restartResult) state.alive = true;
      return state.restartResult;
    },
    say: (l) => state.lines.push(l),
    describeFault: () => "the GPU ran out of memory 12 times",
    now: () => state.now,
    ...over,
  };
  return { state, sup: new DaemonSupervisor(deps, 1_000_000) };
}

describe("DaemonSupervisor", () => {
  it("restarts a dead daemon it owns after two dead ticks, not one", async () => {
    const { state, sup } = world();
    state.now += 10 * QUICK_DEATH_MS;
    state.alive = false;
    await sup.tick();
    expect(state.restarts).toBe(0);
    await sup.tick();
    expect(state.restarts).toBe(1);
    expect(state.lines).toEqual(["local-llm: the model server died — restarting it (auto-restart)"]);
  });

  it("a live pid resets the count", async () => {
    const { state, sup } = world();
    state.alive = false;
    await sup.tick();
    state.alive = true;
    await sup.tick();
    state.alive = false;
    await sup.tick();
    expect(state.restarts).toBe(0);
  });

  it("stays quiet when it does not own the daemon, or autoRestart is off", async () => {
    for (const flip of ["owns", "enabled"] as const) {
      const { state, sup } = world();
      state[flip] = false;
      state.alive = false;
      for (let i = 0; i < 5; i += 1) await sup.tick();
      expect(state.restarts).toBe(0);
      expect(state.lines).toEqual([]);
    }
  });

  it(`gives up at the ${MAX_QUICK_DEATHS}rd death within a minute of a start, naming the fault`, async () => {
    const { state, sup } = world();
    state.now += 10 * QUICK_DEATH_MS; // the first death comes after a long, healthy run
    const dieAndTick = async () => {
      state.alive = false;
      state.now += 5_000;
      await sup.tick();
      state.now += 3_000;
      await sup.tick();
    };
    await dieAndTick(); // slow death → restart 1
    await dieAndTick(); // quick 1 → restart 2
    await dieAndTick(); // quick 2 → restart 3
    expect(state.restarts).toBe(3);
    await dieAndTick(); // quick 3 → give up
    expect(state.restarts).toBe(3);
    expect(state.lines.at(-1)).toContain(
      "died 3 times within a minute of starting — stopped restarting it: the GPU ran out of memory 12 times",
    );
    // …and stays given up.
    for (let i = 0; i < 4; i += 1) await sup.tick();
    expect(state.restarts).toBe(3);
    // A manual start re-arms it.
    sup.noteStarted();
    state.now += 10 * QUICK_DEATH_MS;
    await dieAndTick();
    expect(state.restarts).toBe(4);
  });

  it("failed starts count as quick deaths, so a start that can never succeed stops too", async () => {
    const { state, sup } = world();
    state.now += 10 * QUICK_DEATH_MS;
    state.restartResult = false;
    state.alive = false;
    for (let i = 0; i < 20; i += 1) {
      state.now += 3_000;
      await sup.tick();
    }
    expect(state.restarts).toBe(MAX_QUICK_DEATHS);
    expect(state.lines.at(-1)).toContain("stopped restarting it");
  });

  it("a daemon that stays up past the window clears the quick-death count", async () => {
    const { state, sup } = world();
    const dieAndTick = async () => {
      state.alive = false;
      state.now += 3_000;
      await sup.tick();
      state.now += 3_000;
      await sup.tick();
    };
    await dieAndTick();
    await dieAndTick();
    state.now += 2 * QUICK_DEATH_MS;
    await sup.tick(); // alive, long enough
    await dieAndTick();
    await dieAndTick();
    expect(state.restarts).toBe(4);
  });

  it("concurrent recover calls share one restart", async () => {
    let release!: () => void;
    const { state, sup } = world({
      restart: () =>
        new Promise<boolean>((r) => {
          state.restarts += 1;
          release = () => r(true);
        }),
    });
    state.now += 10 * QUICK_DEATH_MS;
    const a = sup.recover("the model server stopped answering");
    const b = sup.recover("the model server stopped answering");
    await sup.tick(); // a tick during a recovery does nothing
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(state.restarts).toBe(1);
  });
});
