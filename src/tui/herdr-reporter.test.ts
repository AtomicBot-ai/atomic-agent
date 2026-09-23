import { describe, expect, it, vi } from "vitest";

import {
  createHerdrReporter,
  deriveHerdrReport,
  detectHerdrEnv,
  HerdrReporter,
} from "./herdr-reporter.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

const PANE_ENV = {
  HERDR_ENV: "1",
  HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
  HERDR_PANE_ID: "w1:p2",
};

function makeSpawn() {
  const child = { on: vi.fn(), unref: vi.fn() };
  const spawnFn = vi.fn(() => child);
  return { spawnFn: spawnFn as never, calls: spawnFn.mock.calls, child };
}

function reporter() {
  const { spawnFn, calls } = makeSpawn();
  return {
    reporter: new HerdrReporter(
      { binPath: "/opt/herdr/bin/herdr", paneId: "w1:p2" },
      spawnFn,
      () => 5_000,
    ),
    calls,
  };
}

describe("detectHerdrEnv", () => {
  it("returns null outside herdr", () => {
    expect(detectHerdrEnv({})).toBeNull();
    expect(detectHerdrEnv({ ...PANE_ENV, HERDR_ENV: "0" })).toBeNull();
  });

  it("returns null when the flag is set but the call ingredients are missing", () => {
    expect(detectHerdrEnv({ HERDR_ENV: "1" })).toBeNull();
    expect(
      detectHerdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "/bin/herdr" }),
    ).toBeNull();
  });

  it("returns the runtime env inside a pane", () => {
    expect(detectHerdrEnv(PANE_ENV)).toEqual({
      binPath: "/opt/herdr/bin/herdr",
      paneId: "w1:p2",
    });
  });
});

describe("deriveHerdrReport", () => {
  const approval = { tool: "os.fs.write" } as ApprovalRequest;

  it("maps running to working and idle/quitting to idle", () => {
    expect(
      deriveHerdrReport({ status: "running", pendingApproval: null, planHandoff: false }),
    ).toEqual({ state: "working" });
    expect(
      deriveHerdrReport({ status: "idle", pendingApproval: null, planHandoff: false }),
    ).toEqual({ state: "idle" });
    expect(
      deriveHerdrReport({ status: "quitting", pendingApproval: null, planHandoff: false }),
    ).toEqual({ state: "idle" });
  });

  it("reports an approval as blocked with the tool as the message", () => {
    expect(
      deriveHerdrReport({
        status: "awaiting_approval",
        pendingApproval: approval,
        planHandoff: false,
      }),
    ).toEqual({ state: "blocked", message: "os.fs.write" });
  });

  it("lets a pending approval win over a running status", () => {
    expect(
      deriveHerdrReport({ status: "running", pendingApproval: approval, planHandoff: false })
        .state,
    ).toBe("blocked");
  });

  it("reports the plan hand-off as blocked", () => {
    expect(
      deriveHerdrReport({ status: "idle", pendingApproval: null, planHandoff: true }),
    ).toEqual({ state: "blocked", message: "plan ready" });
  });
});

describe("HerdrReporter", () => {
  it("spawns report-agent with the pane, label and sequence", () => {
    const { reporter: r, calls } = reporter();
    r.report("working");
    expect(calls).toHaveLength(1);
    const [bin, args, opts] = calls[0] as unknown as [
      string,
      string[],
      { stdio: string },
    ];
    expect(bin).toBe("/opt/herdr/bin/herdr");
    expect(args).toEqual([
      "pane",
      "report-agent",
      "w1:p2",
      "--source",
      "custom:atomic",
      "--agent",
      "atomic",
      "--state",
      "working",
      "--seq",
      "6",
    ]);
    expect(opts.stdio).toBe("ignore");
  });

  it("appends the message when one is given", () => {
    const { reporter: r, calls } = reporter();
    r.report("blocked", "os.fs.write");
    const args = calls[0]?.[1] as string[];
    expect(args.slice(-2)).toEqual(["--message", "os.fs.write"]);
  });

  it("drops repeats of the same state and message", () => {
    const { reporter: r, calls } = reporter();
    r.report("working");
    r.report("working");
    r.report("blocked", "os.fs.write");
    r.report("blocked", "os.fs.write");
    r.report("blocked", "os.shell");
    expect(calls).toHaveLength(3);
  });

  it("increments the sequence across distinct reports", () => {
    const { reporter: r, calls } = reporter();
    r.report("working");
    r.report("idle");
    const seqOf = (call: unknown[]) => {
      const args = call[1] as string[];
      return args[args.indexOf("--seq") + 1];
    };
    expect(seqOf(calls[0]!)).toBe("6");
    expect(seqOf(calls[1]!)).toBe("7");
  });

  it("release spawns release-agent once, above the last seq, and mutes later reports", () => {
    const { reporter: r, calls } = reporter();
    r.report("working");
    r.release();
    r.release();
    r.report("idle");
    expect(calls).toHaveLength(2);
    // herdr drops a release whose seq is not above the last report's,
    // so the label would stick to a dead pane without the bump.
    expect(calls[1]?.[1]).toEqual([
      "pane",
      "release-agent",
      "w1:p2",
      "--source",
      "custom:atomic",
      "--agent",
      "atomic",
      "--seq",
      "7",
    ]);
  });

  it("starts the sequence from epoch seconds so restarts outrank old runs", () => {
    const { spawnFn, calls } = makeSpawn();
    const r = new HerdrReporter(
      { binPath: "/bin/herdr", paneId: "w1:p1" },
      spawnFn,
      () => 1_700_000_000_000,
    );
    r.report("working");
    const args = calls[0]?.[1] as string[];
    expect(args[args.indexOf("--seq") + 1]).toBe("1700000001");
  });

  it("swallows spawn failures", () => {
    const spawnFn = vi.fn(() => {
      throw new Error("herdr is gone");
    });
    const r = new HerdrReporter(
      { binPath: "/bin/herdr", paneId: "w1:p1" },
      spawnFn as never,
    );
    expect(() => r.report("working")).not.toThrow();
    expect(() => r.release()).not.toThrow();
  });
});

describe("createHerdrReporter", () => {
  it("returns null outside herdr and a reporter inside", () => {
    const { spawnFn } = makeSpawn();
    expect(createHerdrReporter({}, spawnFn)).toBeNull();
    expect(createHerdrReporter(PANE_ENV, spawnFn)).toBeInstanceOf(HerdrReporter);
  });
});
