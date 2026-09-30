import { describe, expect, it } from "vitest";

import {
  DaemonSupervisor,
  MAX_QUICK_DEATHS,
  QUICK_DEATH_MS,
  type DaemonSupervisorDeps,
  type SupervisorNotice,
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
    notices: [] as SupervisorNotice[],
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
    notify: (n) => state.notices.push(n),
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
    expect(state.lines).toEqual([
      "local-llm: the model server died — restarting it (auto-restart)",
      "local-llm: the model server is back up after 0 s (auto-restart)",
    ]);
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

  describe("chat notices — one per incident", () => {
    const dieAndTick = async (state: ReturnType<typeof world>["state"], sup: DaemonSupervisor) => {
      state.alive = false;
      state.now += 5_000;
      await sup.tick();
      state.now += 3_000;
      await sup.tick();
    };

    it("died → restarting → back up: two notices, the second closing the first", async () => {
      const { state, sup } = world({
        restart: async () => {
          state.now += 14_000;
          state.alive = true;
          return true;
        },
      });
      state.now += 10 * QUICK_DEATH_MS;
      await dieAndTick(state, sup);
      expect(state.notices).toEqual([
        { kind: "restarting", cause: "died", reason: "the model server died", quickDeaths: 0 },
        { kind: "restarted", afterMs: 14_000 },
      ]);
    });

    it("a wedge restart says it hung, with the watchdog's reading", async () => {
      const { state, sup } = world();
      state.now += 10 * QUICK_DEATH_MS;
      await sup.recover("the model server stopped answering (95 s without a reply to /health or /slots)");
      expect(state.notices[0]).toMatchObject({ kind: "restarting", cause: "wedged" });
      expect(state.notices[1]).toMatchObject({ kind: "restarted" });
    });

    it("a crash loop: failed restarts are told once, then one give-up naming the fault", async () => {
      const { state, sup } = world();
      state.now += 10 * QUICK_DEATH_MS;
      state.restartResult = false;
      state.alive = false;
      for (let i = 0; i < 20; i += 1) {
        state.now += 3_000;
        await sup.tick();
      }
      expect(state.notices.map((n) => n.kind)).toEqual(["restarting", "restart_failed", "gave_up"]);
      expect(state.notices.at(-1)).toEqual({
        kind: "gave_up",
        deaths: MAX_QUICK_DEATHS,
        fault: "the GPU ran out of memory 12 times",
      });
      // Every attempt still has its feed line.
      expect(state.lines.filter((l) => l.includes("automatic restart failed"))).toHaveLength(MAX_QUICK_DEATHS);
    });

    it("dying again right after a good restart opens a new incident that says so", async () => {
      const { state, sup } = world();
      state.now += 10 * QUICK_DEATH_MS;
      await dieAndTick(state, sup);
      await dieAndTick(state, sup);
      expect(state.notices.map((n) => n.kind)).toEqual(["restarting", "restarted", "restarting", "restarted"]);
      expect(state.notices[2]).toMatchObject({ quickDeaths: 1 });
    });

    it("the operator's own start ends an open incident without a notice", async () => {
      const { state, sup } = world();
      state.now += 10 * QUICK_DEATH_MS;
      state.restartResult = false;
      await dieAndTick(state, sup);
      expect(state.notices.map((n) => n.kind)).toEqual(["restarting", "restart_failed"]);
      sup.noteStarted();
      state.alive = true;
      state.restartResult = true;
      state.now += 10 * QUICK_DEATH_MS;
      await dieAndTick(state, sup);
      // A fresh incident, not the tail of the old one.
      expect(state.notices.map((n) => n.kind)).toEqual(["restarting", "restart_failed", "restarting", "restarted"]);
    });
  });
});
