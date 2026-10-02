import { describe, expect, it } from "vitest";
import { uptime } from "node:os";

import {
  currentTurnOwnerProbe,
  hostUptime,
  isTurnOwnerGone,
  parseTurnOwner,
  readStartTicks,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwner,
  type TurnOwnerProbe,
} from "./turn-owner.js";

/**
 * The boot sweep's one judgement: is the process a `running` row names
 * gone, so the turn will never write its end? Once the pid is alive only
 * certain evidence may say so — cancelling a turn another window is
 * still running is the worse mistake.
 */

function probe(overrides: Partial<TurnOwnerProbe> = {}): TurnOwnerProbe {
  return {
    pid: 100,
    hostUptime: () => 50_000,
    isAlive: () => true,
    startTicksOf: () => null,
    ...overrides,
  };
}

function mark(owner: Partial<TurnOwner> & { pid: number }): string {
  return serializeTurnOwner({ at: 1_790_000_123_456, ...owner });
}

describe("serializeTurnOwner / parseTurnOwner", () => {
  it("reads back what was written", () => {
    const owner: TurnOwner = {
      pid: 4242,
      hostUptime: 40_000,
      startTicks: "123456",
      at: 1_790_000_123_456,
    };
    expect(parseTurnOwner(serializeTurnOwner(owner))).toEqual(owner);
  });

  it("leaves out what the platform could not say", () => {
    expect(parseTurnOwner(mark({ pid: 9 }))).toEqual({
      pid: 9,
      at: 1_790_000_123_456,
    });
  });

  it("is null for no mark, a mark that is not JSON, or one without a usable pid", () => {
    expect(parseTurnOwner(null)).toBeNull();
    expect(parseTurnOwner("{not json")).toBeNull();
    expect(parseTurnOwner("42")).toBeNull();
    expect(parseTurnOwner("null")).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ hostUptime: 5 }))).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ pid: "7" }))).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ pid: 0 }))).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ pid: 1.5 }))).toBeNull();
  });

  it("drops fields of the wrong shape and keeps the pid", () => {
    expect(
      parseTurnOwner(
        JSON.stringify({ pid: 9, hostUptime: "soon", startTicks: 12, at: "x" }),
      ),
    ).toEqual({ pid: 9, at: 0 });
  });
});

describe("turnOwnerFor", () => {
  it("records the probe's process, the host's uptime now and the start ticks", () => {
    let up = 1_000;
    const owner = turnOwnerFor(
      probe({
        pid: 77,
        hostUptime: () => up,
        startTicksOf: (pid) => (pid === 77 ? "555" : null),
      }),
      123,
    );
    expect(owner).toEqual({ pid: 77, hostUptime: 1_000, startTicks: "555", at: 123 });
    // Read at the moment of the mark, not when the probe was built.
    up = 2_000;
    expect(turnOwnerFor(probe({ hostUptime: () => up }), 1).hostUptime).toBe(
      2_000,
    );
  });
});

describe("isTurnOwnerGone", () => {
  it("keeps a turn whose process is alive", () => {
    expect(isTurnOwnerGone(mark({ pid: 200, hostUptime: 40_000 }), probe())).toBe(
      false,
    );
  });

  it("ends a turn whose process has exited", () => {
    const isAlive = (pid: number) => pid !== 200;
    expect(isTurnOwnerGone(mark({ pid: 200 }), probe({ isAlive }))).toBe(true);
    expect(isTurnOwnerGone(mark({ pid: 300 }), probe({ isAlive }))).toBe(false);
  });

  it("ends a turn marked with this process's own pid, without asking whether it is alive", () => {
    // At boot this process has run no turn yet: the mark is an earlier
    // process that had the same number.
    let asked = false;
    const gone = isTurnOwnerGone(
      mark({ pid: 100 }),
      probe({
        isAlive: () => {
          asked = true;
          return true;
        },
      }),
    );
    expect(gone).toBe(true);
    expect(asked).toBe(false);
  });

  it("ends a turn from before a reboot even when its pid is alive now", () => {
    // Up for a day when the mark was written, up for an hour now.
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, hostUptime: 86_400 }),
        probe({ hostUptime: () => 3_600 }),
      ),
    ).toBe(true);
  });

  it("does not read a reboot into an uptime a moment off, or a clock step", () => {
    // Uptime is whole seconds on some platforms; and it does not move
    // with the wall clock, so nothing here can turn a clock step into a
    // reboot.
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, hostUptime: 3_601 }),
        probe({ hostUptime: () => 3_600 }),
      ),
    ).toBe(false);
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, hostUptime: 3_600 }),
        probe({ hostUptime: () => 90_000 }),
      ),
    ).toBe(false);
  });

  it("keeps a live pid when either side does not know the uptime", () => {
    expect(
      isTurnOwnerGone(
        mark({ pid: 200 }),
        probe({ hostUptime: () => 1 }),
      ),
    ).toBe(false);
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, hostUptime: 86_400 }),
        probe({ hostUptime: () => undefined }),
      ),
    ).toBe(false);
  });

  it("ends a turn whose pid now belongs to a process that started at another moment", () => {
    const startTicksOf = (pid: number) => (pid === 200 ? "999" : null);
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, startTicks: "555" }),
        probe({ startTicksOf }),
      ),
    ).toBe(true);
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, startTicks: "999" }),
        probe({ startTicksOf }),
      ),
    ).toBe(false);
  });

  it("keeps a live pid whose start time cannot be read", () => {
    expect(
      isTurnOwnerGone(mark({ pid: 200, startTicks: "555" }), probe()),
    ).toBe(false);
  });

  it("ends a live status with no mark, or a mark that does not parse", () => {
    expect(isTurnOwnerGone(null, probe())).toBe(true);
    expect(isTurnOwnerGone("garbage", probe())).toBe(true);
  });
});

describe("the live probe", () => {
  it("reports this process, a positive uptime and itself as alive", () => {
    const live = currentTurnOwnerProbe();
    expect(live.pid).toBe(process.pid);
    expect(live.isAlive(process.pid)).toBe(true);
    const up = live.hostUptime();
    expect(up).toBeGreaterThan(0);
    expect(Math.abs((up ?? 0) - uptime())).toBeLessThanOrEqual(2);
    expect(hostUptime()).toBeGreaterThan(0);
  });

  it("reads start ticks only where the kernel offers them", () => {
    const own = readStartTicks(process.pid);
    if (process.platform === "linux") {
      expect(own).toMatch(/^\d+$/);
      // The same process reads the same start twice.
      expect(readStartTicks(process.pid)).toBe(own);
    } else {
      expect(own).toBeNull();
    }
  });
});
