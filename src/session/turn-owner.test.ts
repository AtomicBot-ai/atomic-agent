import { describe, expect, it } from "vitest";
import { uptime } from "node:os";

import {
  currentTurnOwnerProbe,
  hostIdentity,
  hostUptime,
  isTurnOwnerGone,
  parseTurnOwner,
  processStartOf,
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

const DB = "/state/sessions.sqlite";

function probe(overrides: Partial<TurnOwnerProbe> = {}): TurnOwnerProbe {
  return {
    pid: 100,
    host: "darwin",
    hostUptime: () => 50_000,
    isAlive: () => true,
    processStartOf: () => null,
    ...overrides,
  };
}

function mark(owner: Partial<TurnOwner> & { pid: number }): string {
  return serializeTurnOwner({ host: "darwin", at: 1_790_000_123_456, ...owner });
}

describe("serializeTurnOwner / parseTurnOwner", () => {
  it("reads back what was written", () => {
    const owner: TurnOwner = {
      pid: 4242,
      host: "linux:pid:[4026531836]",
      db: DB,
      hostUptime: 40_000,
      processStart: "ticks:123456",
      at: 1_790_000_123_456,
    };
    expect(parseTurnOwner(serializeTurnOwner(owner))).toEqual(owner);
  });

  it("leaves out what the platform could not say", () => {
    expect(
      parseTurnOwner(serializeTurnOwner({ pid: 9, at: 1_790_000_123_456 })),
    ).toEqual({ pid: 9, at: 1_790_000_123_456 });
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
        JSON.stringify({
          pid: 9,
          host: 3,
          db: "",
          hostUptime: "soon",
          processStart: 12,
          at: "x",
        }),
      ),
    ).toEqual({ pid: 9, at: 0 });
  });
});

describe("turnOwnerFor", () => {
  it("records the probe's process and host, the database, the uptime now and the start", () => {
    let up = 1_000;
    const owner = turnOwnerFor(
      probe({
        pid: 77,
        hostUptime: () => up,
        processStartOf: (pid) => (pid === 77 ? "lstart:Fri Oct 2 12:10:29 2026" : null),
      }),
      123,
      DB,
    );
    expect(owner).toEqual({
      pid: 77,
      host: "darwin",
      db: DB,
      hostUptime: 1_000,
      processStart: "lstart:Fri Oct 2 12:10:29 2026",
      at: 123,
    });
    // Read at the moment of the mark, not when the probe was built.
    up = 2_000;
    expect(turnOwnerFor(probe({ hostUptime: () => up }), 1).hostUptime).toBe(
      2_000,
    );
  });
});

describe("isTurnOwnerGone", () => {
  it("keeps a turn whose process is alive", () => {
    expect(
      isTurnOwnerGone(mark({ pid: 200, db: DB, hostUptime: 40_000 }), probe(), DB),
    ).toBe(false);
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

  it("never judges a mark from another pid namespace, dead pid or not", () => {
    // A container sharing the state dir numbers its processes on its own.
    const foreign = mark({ pid: 7, host: "linux:pid:[4026532415]" });
    const here = probe({
      host: "linux:pid:[4026531836]",
      isAlive: () => false,
    });
    expect(isTurnOwnerGone(foreign, here)).toBe(false);
    // Nor one from another platform sharing the directory.
    expect(isTurnOwnerGone(mark({ pid: 7, host: "win32" }), here)).toBe(false);
  });

  it("ends a turn whose mark was written into another database file — a copy", () => {
    // The desktop's import copies the terminal agent's sessions.sqlite
    // while a turn may be running there; that turn runs on the original.
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, db: "/home/u/.atomic-agent/sessions.sqlite" }),
        probe(),
        "/home/u/.atomic-agent-desktop/sessions.sqlite",
      ),
    ).toBe(true);
    // The same file is the same turn.
    expect(isTurnOwnerGone(mark({ pid: 200, db: DB }), probe(), DB)).toBe(false);
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
      isTurnOwnerGone(mark({ pid: 200 }), probe({ hostUptime: () => 1 })),
    ).toBe(false);
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, hostUptime: 86_400 }),
        probe({ hostUptime: () => undefined }),
      ),
    ).toBe(false);
  });

  it("ends a turn whose pid now belongs to a process that started at another moment", () => {
    const processStartOf = (pid: number) =>
      pid === 200 ? "lstart:Fri Oct 2 12:10:29 2026" : null;
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, processStart: "lstart:Thu Oct 1 09:00:00 2026" }),
        probe({ processStartOf }),
      ),
    ).toBe(true);
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, processStart: "lstart:Fri Oct 2 12:10:29 2026" }),
        probe({ processStartOf }),
      ),
    ).toBe(false);
  });

  it("keeps a live pid whose start cannot be read", () => {
    expect(
      isTurnOwnerGone(
        mark({ pid: 200, processStart: "lstart:Thu Oct 1 09:00:00 2026" }),
        probe(),
      ),
    ).toBe(false);
  });

  it("ends a live status with no mark, or a mark that does not parse", () => {
    expect(isTurnOwnerGone(null, probe())).toBe(true);
    expect(isTurnOwnerGone("garbage", probe())).toBe(true);
  });
});

describe("the live probe", () => {
  it("reports this process, its host, a positive uptime and itself as alive", () => {
    const live = currentTurnOwnerProbe();
    expect(live.pid).toBe(process.pid);
    expect(live.host).toBe(hostIdentity());
    expect(live.isAlive(process.pid)).toBe(true);
    const up = live.hostUptime();
    expect(up).toBeGreaterThan(0);
    expect(Math.abs((up ?? 0) - uptime())).toBeLessThanOrEqual(2);
    expect(hostUptime()).toBeGreaterThan(0);
  });

  it("names the host by platform, and the pid namespace on Linux", () => {
    const host = hostIdentity();
    if (process.platform === "linux") {
      expect(host).toMatch(/^linux(:pid:\[\d+\])?$/);
    } else {
      expect(host).toBe(process.platform);
    }
  });

  it("reads a process's start where the platform offers it, the same on every read", () => {
    const own = processStartOf(process.pid);
    if (process.platform === "linux") {
      expect(own).toMatch(/^ticks:\d+$/);
    } else if (process.platform === "darwin") {
      expect(own).toMatch(/^lstart:\S/);
    } else {
      expect(own).toBeNull();
    }
    expect(processStartOf(process.pid)).toBe(own);
    // A pid with no process behind it is unknown, never a value.
    expect(processStartOf(2_147_483_646)).toBeNull();
  });
});
