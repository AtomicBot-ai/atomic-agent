import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPidAlive,
  noteReleaseTimeout,
  waitForProcessRelease,
  type ReleaseWaitDeps,
} from "./process-release.js";

/** A clock that only moves when the wait sleeps, so no test waits for real. */
function fakeClock(): Required<Pick<ReleaseWaitDeps, "now" | "sleep">> & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
}

/** True for the first `n` calls, false after. */
function trueFor(n: number): () => boolean {
  let calls = 0;
  return () => calls++ < n;
}

describe("waitForProcessRelease", () => {
  it("waits until the process is gone and then the port is free", async () => {
    const clock = fakeClock();
    const portChecks: number[] = [];
    const pidAlive = trueFor(3);
    const portHeld = trueFor(2);
    const result = await waitForProcessRelease(4242, 8080, { timeoutMs: 3000, pollMs: 100 }, {
      ...clock,
      pidAlive: () => pidAlive(),
      portOpen: async (port) => {
        portChecks.push(port);
        return portHeld();
      },
    });
    expect(result).toEqual({ released: true, waitedMs: 500 });
    // The port is probed only after the process is gone.
    expect(portChecks).toEqual([8080, 8080, 8080]);
    expect(clock.slept).toEqual([100, 100, 100, 100, 100]);
  });

  it("returns at once when the process is already gone and the port free", async () => {
    const clock = fakeClock();
    const result = await waitForProcessRelease(4242, 8080, {}, {
      ...clock,
      pidAlive: () => false,
      portOpen: async () => false,
    });
    expect(result).toEqual({ released: true, waitedMs: 0 });
    expect(clock.slept).toEqual([]);
  });

  it("waits for the process alone when no port is known", async () => {
    const clock = fakeClock();
    const portOpen = vi.fn(async () => true);
    const result = await waitForProcessRelease(4242, null, { pollMs: 50 }, {
      ...clock,
      pidAlive: trueFor(2),
      portOpen,
    });
    expect(result).toEqual({ released: true, waitedMs: 100 });
    expect(portOpen).not.toHaveBeenCalled();
  });

  it("gives up after the bound when the process never exits", async () => {
    const clock = fakeClock();
    const result = await waitForProcessRelease(4242, 8080, { timeoutMs: 1000, pollMs: 250 }, {
      ...clock,
      pidAlive: () => true,
      portOpen: async () => true,
    });
    expect(result).toEqual({ released: false, waitedMs: 1000, holding: "process" });
  });

  it("gives up after the bound when the port stays held", async () => {
    const clock = fakeClock();
    const result = await waitForProcessRelease(4242, 8080, { timeoutMs: 300, pollMs: 100 }, {
      ...clock,
      pidAlive: () => false,
      portOpen: async () => true,
    });
    expect(result).toEqual({ released: false, waitedMs: 300, holding: "port" });
  });
});

describe("noteReleaseTimeout", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("appends one line when the wait ran out, and nothing when it did not", () => {
    dir = mkdtempSync(join(tmpdir(), "release-note-"));
    const log = join(dir, "llama-server.log");
    writeFileSync(log, "before\n", "utf-8");
    noteReleaseTimeout(log, 4242, 8080, { released: true, waitedMs: 20 });
    expect(readFileSync(log, "utf-8")).toBe("before\n");
    noteReleaseTimeout(log, 4242, 8080, { released: false, waitedMs: 3000, holding: "port" });
    expect(readFileSync(log, "utf-8")).toContain("port 8080 was still in use 3000ms after the stop");
  });

  it("never throws when the log cannot be written", () => {
    expect(() =>
      noteReleaseTimeout(join(tmpdir(), "no-such-dir-release", "x.log"), 1, null, {
        released: false,
        waitedMs: 1,
        holding: "process",
      }),
    ).not.toThrow();
  });
});

describe("isPidAlive", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads ESRCH as gone and EPERM as alive", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    vi.spyOn(process, "kill").mockImplementation(fail("ESRCH"));
    expect(isPidAlive(4242)).toBe(false);
    vi.spyOn(process, "kill").mockImplementation(fail("EPERM"));
    expect(isPidAlive(4242)).toBe(true);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(isPidAlive(4242)).toBe(true);
  });
});
