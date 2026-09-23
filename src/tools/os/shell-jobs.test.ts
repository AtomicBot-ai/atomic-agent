import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandJob, CommandJobExit } from "../../sandbox/command-job.js";
import { checkShellCommandGuard } from "./shell-command-guard/index.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import type { ShellCommandFacts } from "./shell-result.js";

/**
 * The registry's ownership rules, with a fake job so no process is
 * involved: ids per session, turn-end vs `keep`, session-end, the job
 * limit's eviction order, the ceiling.
 */

interface FakeJob extends CommandJob {
  stops: number;
  finish(exit: CommandJobExit): void;
}

function fakeJob(startedAt = Date.now()): FakeJob {
  let resolveExit!: (exit: CommandJobExit) => void;
  let exited: CommandJobExit | null = null;
  const exit = new Promise<CommandJobExit>((resolve) => {
    resolveExit = resolve;
  });
  const job: FakeJob = {
    command: "sleep",
    args: ["30"],
    pid: 4242,
    startedAt,
    exit,
    stops: 0,
    exited: () => exited,
    output: () => ({ stdout: "", stderr: "", truncated: false }),
    waitFor: () => Promise.resolve("elapsed" as const),
    stop() {
      job.stops += 1;
    },
    kill() {
      job.stops += 1;
    },
    finish(value) {
      exited = value;
      resolveExit(value);
    },
  };
  return job;
}

function facts(cmd: string): ShellCommandFacts {
  return {
    cmd,
    args: [],
    rawArgs: [],
    cwd: "/tmp",
    shell: false,
    commandLine: cmd,
    noArguments: false,
    gog: false,
    guard: checkShellCommandGuard({ cmd, rawArgs: [], cwd: "/tmp" }),
  };
}

describe("ShellJobRegistry", () => {
  it("numbers jobs per session from 1 and hides them from other sessions", () => {
    const registry = new ShellJobRegistry();
    const a1 = registry.register("a", fakeJob(), facts("one"), false).record;
    const a2 = registry.register("a", fakeJob(), facts("two"), false).record;
    const b1 = registry.register("b", fakeJob(), facts("three"), false).record;
    expect([a1.id, a2.id, b1.id]).toEqual([1, 2, 1]);
    expect(registry.get("a", 2)).toBe(a2);
    expect(registry.get("b", 2)).toBeUndefined();
    expect(registry.list("a").map((r) => r.id)).toEqual([1, 2]);
  });

  it("endTurn stops the un-kept jobs and leaves kept ones for a later turn", () => {
    const registry = new ShellJobRegistry();
    const plain = fakeJob();
    const kept = fakeJob();
    registry.register("s", plain, facts("plain"), false);
    const keptRecord = registry.register("s", kept, facts("kept"), true).record;
    const stopped = registry.endTurn("s");
    expect(stopped.map((r) => r.facts.cmd)).toEqual(["plain"]);
    expect(plain.stops).toBe(1);
    expect(kept.stops).toBe(0);
    expect(registry.list("s")).toEqual([keptRecord]);
    expect(keptRecord.state).toBe("running");
  });

  it("a later markKeep protects a job the call did not keep", () => {
    const registry = new ShellJobRegistry();
    const job = fakeJob();
    const record = registry.register("s", job, facts("x"), false).record;
    registry.markKeep(record);
    expect(registry.endTurn("s")).toEqual([]);
    expect(job.stops).toBe(0);
  });

  it("endSession and endAll stop kept jobs too", () => {
    const registry = new ShellJobRegistry();
    const a = fakeJob();
    const b = fakeJob();
    registry.register("s", a, facts("a"), true);
    registry.register("t", b, facts("b"), true);
    expect(registry.endSession("s").length).toBe(1);
    expect(a.stops).toBe(1);
    expect(registry.list("s")).toEqual([]);
    expect(registry.endAll().map((r) => r.facts.cmd)).toEqual(["b"]);
    expect(b.stops).toBe(1);
  });

  it("stop marks the record killed with its reason, and only once", () => {
    const registry = new ShellJobRegistry();
    const job = fakeJob();
    const record = registry.register("s", job, facts("x"), false).record;
    expect(registry.stop(record, "kill")).toBe(true);
    expect(registry.stop(record, "ceiling")).toBe(false);
    expect(record).toMatchObject({ state: "killed", stopReason: "kill" });
    expect(job.stops).toBe(1);
  });

  it("marks a job exited when its process closes, and drop forgets it", async () => {
    const registry = new ShellJobRegistry();
    const job = fakeJob();
    const record = registry.register("s", job, facts("x"), false).record;
    job.finish({ exitCode: 0, signal: null, durationMs: 10 });
    await job.exit;
    expect(record.state).toBe("exited");
    registry.drop(record);
    expect(registry.get("s", 1)).toBeUndefined();
  });

  it("at maxJobs the next detach evicts the oldest un-kept job, then the oldest kept one", () => {
    const registry = new ShellJobRegistry({ maxJobs: 2 });
    const first = fakeJob();
    const second = fakeJob();
    const r1 = registry.register("s", first, facts("first"), true).record;
    registry.register("s", second, facts("second"), false);
    const third = registry.register("s", fakeJob(), facts("third"), false);
    // `second` is the oldest un-kept one; `first` is older but kept.
    expect(third.evicted?.facts.cmd).toBe("second");
    expect(second.stops).toBe(1);
    expect(first.stops).toBe(0);
    // Now first (kept) and third (un-kept) run; keep third too, so the
    // next detach has no un-kept job and takes the oldest kept one.
    registry.markKeep(third.record);
    const fourth = registry.register("s", fakeJob(), facts("fourth"), false);
    expect(fourth.evicted).toBe(r1);
    expect(first.stops).toBe(1);
    expect(r1.stopReason).toBe("evicted");
  });

  describe("ceiling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops a job jobMaxMs after its start, whether kept or not", () => {
      const registry = new ShellJobRegistry({ jobMaxMs: 10_000 });
      // Started 4 s before the detach: 6 s of ceiling remain.
      const job = fakeJob(Date.now() - 4_000);
      const record = registry.register("s", job, facts("x"), true).record;
      vi.advanceTimersByTime(5_900);
      expect(job.stops).toBe(0);
      vi.advanceTimersByTime(200);
      expect(job.stops).toBe(1);
      expect(record).toMatchObject({ state: "killed", stopReason: "ceiling" });
    });

    it("does not fire for a job that was dropped or already stopped", () => {
      const registry = new ShellJobRegistry({ jobMaxMs: 1_000 });
      const dropped = fakeJob();
      const stopped = fakeJob();
      registry.drop(registry.register("s", dropped, facts("a"), false).record);
      registry.stop(registry.register("s", stopped, facts("b"), false).record, "kill");
      vi.advanceTimersByTime(2_000);
      expect(dropped.stops).toBe(0);
      expect(stopped.stops).toBe(1);
    });
  });
});
