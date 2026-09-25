import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProbeOutcome, ServeHealth } from "./serve-probe.js";
import {
  formatReapOutcomes,
  readServeRecords,
  reapOrphanedServes,
  registerServe,
  type ReapVerdict,
  type ServeRecord,
} from "./serve-reaper.js";

const DEAD_PID = 999_999;
/** Alive and not us — the reaper skips its own pid. */
const LIVE_PID = process.ppid;

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "serve-reaper-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** Abandoned by default: alive server, dead spawner, not a daemon. */
function record(over: Partial<ServeRecord> = {}): ServeRecord {
  return {
    pid: LIVE_PID,
    bootPpid: DEAD_PID,
    daemon: false,
    host: "127.0.0.1",
    port: 8787,
    cwd: "/tmp",
    startedAt: "2026-09-25T00:00:00.000Z",
    ...over,
  };
}

function seed(over: Partial<ServeRecord> = {}): ServeRecord {
  const written = record(over);
  registerServe(stateDir, written);
  return written;
}

function recordFiles(): string[] {
  try {
    return readdirSync(join(stateDir, "serve"));
  } catch {
    return [];
  }
}

/** A `/health` answer that clears every gate, for tests to spoil one at a time. */
function healthyOrphan(over: Partial<ServeHealth> = {}): ProbeOutcome {
  return {
    kind: "health",
    health: { runtime: "atomic-agent", pid: LIVE_PID, ppid: 1, busyTurns: 0, ...over },
  };
}

/** Reap with everything injected: no real signal ever leaves the test. */
async function reap(
  probed: ProbeOutcome,
  signal = vi.fn(),
): Promise<{ verdicts: ReapVerdict[]; signal: ReturnType<typeof vi.fn> }> {
  const outcomes = await reapOrphanedServes({
    stateDir,
    probe: async () => probed,
    signal,
    graceMs: 0,
  });
  return { verdicts: outcomes.map((o) => o.verdict), signal };
}

describe("registerServe / readServeRecords", () => {
  it("round-trips a record and releases it idempotently", () => {
    const written = seed();
    expect(readServeRecords(stateDir).map((r) => r.record)).toEqual([written]);

    const release = registerServe(stateDir, written);
    release();
    release();
    expect(readServeRecords(stateDir)).toEqual([]);
  });

  it("returns nothing when the directory was never created", () => {
    expect(readServeRecords(stateDir)).toEqual([]);
  });

  it("drops files that are not a record instead of choking on them", () => {
    seed();
    writeFileSync(join(stateDir, "serve", "junk.json"), "not json", "utf8");
    writeFileSync(join(stateDir, "serve", "nopid.json"), '{"port":1}', "utf8");
    expect(readServeRecords(stateDir)).toHaveLength(1);
    expect(recordFiles()).toEqual([`${LIVE_PID}.json`]);
  });
});

describe("reapOrphanedServes — deliberate daemons are untouchable", () => {
  it("never signals a record marked daemon, however abandoned it looks", async () => {
    // --no-parent-exit, or a boot that was already parentless. Every
    // other gate here says "reap"; the daemon flag alone must stop it.
    seed({ daemon: true });
    const { verdicts, signal } = await reap(healthyOrphan());
    expect(verdicts).toEqual(["daemon"]);
    expect(signal).not.toHaveBeenCalled();
    expect(recordFiles()).toEqual([`${LIVE_PID}.json`]);
  });

  it("leaves a server whose spawner is still alive, and keeps its record", async () => {
    // Parentlessness is NOT the test — abandonment is. A long-lived
    // server whose spawner is still around is simply in use.
    seed({ bootPpid: process.pid });
    const { verdicts, signal } = await reap(healthyOrphan());
    expect(verdicts).toEqual(["owned"]);
    expect(signal).not.toHaveBeenCalled();
    expect(recordFiles()).toEqual([`${LIVE_PID}.json`]);
  });

  it("fails closed on a record written before bootPpid existed", async () => {
    const legacy = { ...record() } as Partial<ServeRecord>;
    delete legacy.bootPpid;
    registerServe(stateDir, legacy as ServeRecord);
    const { verdicts, signal } = await reap(healthyOrphan());
    expect(verdicts).toEqual(["owned"]);
    expect(signal).not.toHaveBeenCalled();
  });
});

describe("reapOrphanedServes — what else it refuses to touch", () => {
  it("drops a record whose process is dead, without probing or signalling", async () => {
    seed({ pid: DEAD_PID });
    const probe = vi.fn(async (): Promise<ProbeOutcome> => healthyOrphan());
    const signal = vi.fn();
    const outcomes = await reapOrphanedServes({ stateDir, probe, signal, graceMs: 0 });
    expect(outcomes.map((o) => o.verdict)).toEqual(["stale"]);
    expect(probe).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(recordFiles()).toEqual([]);
  });

  it("keeps the record when the server is listening but too slow to answer", async () => {
    // A hung llama-server inside /health does this. Dropping the record
    // would make that server invisible to every future sweep.
    seed();
    const { verdicts, signal } = await reap({ kind: "unreachable" });
    expect(verdicts).toEqual(["unreachable"]);
    expect(signal).not.toHaveBeenCalled();
    expect(recordFiles()).toEqual([`${LIVE_PID}.json`]);
  });

  it("drops a record whose port answers as something else entirely", async () => {
    seed();
    const { verdicts, signal } = await reap({
      kind: "health",
      health: { runtime: "some-other-server", pid: LIVE_PID, ppid: 1, busyTurns: 0 },
    });
    expect(verdicts).toEqual(["stale"]);
    expect(signal).not.toHaveBeenCalled();
    expect(recordFiles()).toEqual([]);
  });

  it("never signals a recycled pid: right runtime, wrong pid", async () => {
    seed();
    const { verdicts, signal } = await reap(healthyOrphan({ pid: LIVE_PID + 1 }));
    expect(verdicts).toEqual(["stale"]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("fails closed when /health omits ppid", async () => {
    seed();
    const spoiled = healthyOrphan();
    const health = { ...spoiled.health } as Partial<ServeHealth>;
    delete health.ppid;
    const { verdicts, signal } = await reap({ kind: "health", health });
    expect(verdicts).toEqual(["owned"]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("leaves a server that has not actually been reparented", async () => {
    seed();
    const { verdicts, signal } = await reap(healthyOrphan({ ppid: DEAD_PID }));
    expect(verdicts).toEqual(["owned"]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("fails closed when /health omits busyTurns", async () => {
    seed();
    const spoiled = healthyOrphan();
    const health = { ...spoiled.health } as Partial<ServeHealth>;
    delete health.busyTurns;
    const { verdicts, signal } = await reap({ kind: "health", health });
    expect(verdicts).toEqual(["busy"]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("leaves an orphan that is mid-turn — work outranks tidiness", async () => {
    seed();
    const { verdicts, signal } = await reap(healthyOrphan({ busyTurns: 2 }));
    expect(verdicts).toEqual(["busy"]);
    expect(signal).not.toHaveBeenCalled();
    expect(recordFiles()).toEqual([`${LIVE_PID}.json`]);
  });

  it("skips its own record", async () => {
    seed({ pid: process.pid });
    const { verdicts, signal } = await reap(healthyOrphan({ pid: process.pid }));
    expect(verdicts).toEqual([]);
    expect(signal).not.toHaveBeenCalled();
  });
});

describe("reapOrphanedServes — what it does clear", () => {
  it("signals a server that is abandoned, idle and positively identified", async () => {
    seed();
    const { verdicts, signal } = await reap(healthyOrphan());
    expect(verdicts).toEqual(["reaped"]);
    expect(signal).toHaveBeenCalledWith(LIVE_PID, "SIGTERM");
    expect(recordFiles()).toEqual([]);
  });

  it("escalates to SIGKILL only when SIGTERM did not take", async () => {
    seed();
    // The injected signal is a no-op, so the pid is still alive after
    // the grace window — exactly the wedged case.
    const { signal } = await reap(healthyOrphan());
    expect(signal.mock.calls).toEqual([
      [LIVE_PID, "SIGTERM"],
      [LIVE_PID, "SIGKILL"],
    ]);
  });

  it("survives the process exiting between the check and the kill", async () => {
    seed();
    const signal = vi.fn(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const { verdicts } = await reap(healthyOrphan(), signal);
    expect(verdicts).toEqual(["reaped"]);
    expect(recordFiles()).toEqual([]);
  });
});

describe("formatReapOutcomes", () => {
  it("says so plainly when there was nothing on record", () => {
    expect(formatReapOutcomes([])).toContain("no stray servers on record");
  });

  it("lists one line per record with its verdict", () => {
    const text = formatReapOutcomes([
      { record: record({ pid: 41 }), verdict: "reaped" },
      { record: record({ pid: 42 }), verdict: "daemon" },
    ]);
    expect(text).toContain("swept 2 record(s)");
    expect(text).toContain("reaped");
    expect(text).toContain("pid 41 on 127.0.0.1:8787");
    expect(text).toContain("daemon");
    expect(text).toContain("pid 42 on 127.0.0.1:8787");
  });
});
