import { describe, expect, it } from "vitest";
import { uptime } from "node:os";

import {
  hostBootAt,
  isTurnOwnerGone,
  parseTurnOwner,
  serializeTurnOwner,
  type TurnOwnerProbe,
} from "./turn-owner.js";

/**
 * The boot sweep's one judgement: is the process a `running` row names
 * gone, so the turn will never write its end? Every case that cannot
 * prove it must answer "still running" — cancelling a turn another
 * window is running is the worse mistake.
 */

const BOOT = 1_790_000_000;

function probe(overrides: Partial<TurnOwnerProbe> = {}): TurnOwnerProbe {
  return {
    pid: 100,
    bootAt: BOOT,
    isAlive: () => true,
    ...overrides,
  };
}

function mark(pid: number, bootAt: number = BOOT): string {
  return serializeTurnOwner({ pid, bootAt, at: 1_790_000_123_456 });
}

describe("parseTurnOwner", () => {
  it("reads back what serializeTurnOwner wrote", () => {
    expect(parseTurnOwner(mark(4242))).toEqual({
      pid: 4242,
      bootAt: BOOT,
      at: 1_790_000_123_456,
    });
  });

  it("is null for no mark, a mark that is not JSON, or one without a usable pid", () => {
    expect(parseTurnOwner(null)).toBeNull();
    expect(parseTurnOwner("{not json")).toBeNull();
    expect(parseTurnOwner("42")).toBeNull();
    expect(parseTurnOwner("null")).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ bootAt: BOOT }))).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ pid: "7" }))).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ pid: 0 }))).toBeNull();
    expect(parseTurnOwner(JSON.stringify({ pid: 1.5 }))).toBeNull();
  });

  it("defaults a missing boot time and start time to 0", () => {
    expect(parseTurnOwner(JSON.stringify({ pid: 9 }))).toEqual({
      pid: 9,
      bootAt: 0,
      at: 0,
    });
  });
});

describe("isTurnOwnerGone", () => {
  it("keeps a turn whose process is alive on this boot", () => {
    expect(isTurnOwnerGone(mark(200), probe())).toBe(false);
  });

  it("ends a turn whose process has exited", () => {
    const alive = (pid: number) => pid !== 200;
    expect(isTurnOwnerGone(mark(200), probe({ isAlive: alive }))).toBe(true);
    expect(isTurnOwnerGone(mark(300), probe({ isAlive: alive }))).toBe(false);
  });

  it("ends a turn marked with this process's own pid, without asking whether it is alive", () => {
    // At boot this process has run no turn yet: the mark is an earlier
    // process that had the same number.
    let asked = false;
    const gone = isTurnOwnerGone(
      mark(100),
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

  it("ends a turn from an earlier boot even when its pid is alive now", () => {
    expect(isTurnOwnerGone(mark(200, BOOT - 3_600), probe())).toBe(true);
  });

  it("reads two boot times a little apart as the same boot", () => {
    expect(isTurnOwnerGone(mark(200, BOOT - 30), probe())).toBe(false);
    expect(isTurnOwnerGone(mark(200, BOOT + 30), probe())).toBe(false);
  });

  it("skips the boot check when either side does not know its boot time", () => {
    expect(isTurnOwnerGone(mark(200, 0), probe())).toBe(false);
    expect(isTurnOwnerGone(mark(200, BOOT - 3_600), probe({ bootAt: 0 }))).toBe(
      false,
    );
  });

  it("ends a live status with no mark, or a mark that does not parse", () => {
    expect(isTurnOwnerGone(null, probe())).toBe(true);
    expect(isTurnOwnerGone("garbage", probe())).toBe(true);
  });
});

describe("hostBootAt", () => {
  it("is now minus the host's uptime, in whole seconds", () => {
    const now = Date.now();
    const expected = now / 1000 - uptime();
    const bootAt = hostBootAt(now);
    expect(Number.isInteger(bootAt)).toBe(true);
    expect(Math.abs(bootAt - expected)).toBeLessThanOrEqual(2);
  });
});
