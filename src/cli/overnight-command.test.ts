import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { getConfig, resetConfigCache } from "../config/index.js";
import type { OvernightArgs } from "./overnight-args.js";
import {
  OVERNIGHT_STOP_SIGNALS,
  installStopSignals,
  overnightCommand,
  overnightTaskInput,
  unattendedDenial,
} from "./overnight-command.js";

/**
 * The foreground run boots `createAgentRuntime` against the real model
 * wiring and is out of scope here, as for `task run`. This suite covers
 * help, refusals and the `--detach` hand-off with a fake spawn.
 */
describe("overnightCommand", () => {
  let stateDir: string;
  let workDir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-overnight-state-"));
    workDir = mkdtempSync(join(tmpdir(), "atomic-overnight-work-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("prints help", async () => {
    expect(await overnightCommand(["--help"])).toBe(0);
    expect(out.join("")).toContain('atomic-agent overnight "<task>"');
    expect(out.join("")).not.toContain("--task-id");
    expect(out.join("")).toContain("Fusion cloud-worker spend does not count against this cap");
  });

  it("refuses a bad flag before starting anything", async () => {
    const fakeSpawn = vi.fn();
    const code = await overnightCommand(["x", "--hours", "-1", "--detach"], {
      spawn: fakeSpawn as unknown as typeof spawn,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("--hours expects");
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it("--detach starts a background child in --dir and prints how to check it", async () => {
    const unref = vi.fn();
    const fakeSpawn = vi.fn(() => ({ pid: 4242, unref, on: vi.fn() }));
    const code = await overnightCommand(
      ["write the notes", "--dir", workDir, "--budget", "3", "--detach"],
      { spawn: fakeSpawn as unknown as typeof spawn, newTaskId: () => "t-fixed" },
    );
    expect(code).toBe(0);
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [, childArgs, options] = fakeSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean },
    ];
    const tail = childArgs.slice(childArgs.indexOf("overnight"));
    expect(tail).toEqual([
      "overnight",
      "write the notes",
      "--budget",
      "3",
      "--hours",
      "8",
      "--dir",
      workDir,
      "--task-id",
      "t-fixed",
    ]);
    expect(options.cwd).toBe(workDir);
    expect(options.detached).toBe(true);
    expect(unref).toHaveBeenCalled();
    const logPath = join(getConfig().paths.stateDir, "logs", "overnight-t-fixed.log");
    expect(existsSync(logPath)).toBe(true);
    const printed = out.join("");
    expect(printed).toContain("t-fixed");
    expect(printed).toContain("atomic-agent task show t-fixed");
    expect(printed).toContain(logPath);
  });

  it("--detach reports a child that failed to start without crashing on its error event", async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn() });
    const fakeSpawn = vi.fn(() => {
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });
    const code = await overnightCommand(["write the notes", "--dir", workDir, "--detach"], {
      spawn: fakeSpawn as unknown as typeof spawn,
      newTaskId: () => "t-broken",
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("could not start the background run");
    // The error event fires a tick later and must find a listener.
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.listenerCount("error")).toBeGreaterThan(0);
  });
});

describe("overnightTaskInput", () => {
  const args = {
    task: "migrate the tests",
    budgetUsd: 5,
    durationMs: 8 * 3_600_000,
    dir: "/tmp/x",
    notify: null,
    detach: false,
    noApproval: false,
    taskId: null,
  } as unknown as OvernightArgs;

  it("carries the task-wide step ceiling, not the per-leg default", () => {
    const input = overnightTaskInput(args, "t-1", "s-1", {
      agent: { task: { maxSteps: 1000, maxCostUsd: 0 } },
    });
    expect(input.maxSteps).toBe(1000);
    expect(input).toMatchObject({
      id: "t-1",
      sessionId: "s-1",
      userMessage: "migrate the tests",
      origin: "cli",
      maxAttempts: 1,
      maxDurationMs: 8 * 3_600_000,
      maxCostUsd: 5,
    });
  });

  it("writes the config cap on the row when --budget is absent", () => {
    const noBudget = { ...args, budgetUsd: null };
    const input = overnightTaskInput(noBudget, "t-1", "s-1", {
      agent: { task: { maxSteps: 1000, maxCostUsd: 3 } },
    });
    expect(input.maxCostUsd).toBe(3);
  });

  it("prefers --budget over the config cap", () => {
    const input = overnightTaskInput(args, "t-1", "s-1", {
      agent: { task: { maxSteps: 1000, maxCostUsd: 3 } },
    });
    expect(input.maxCostUsd).toBe(5);
  });

  it("leaves the row uncapped when neither sets a cap", () => {
    const noBudget = { ...args, budgetUsd: null };
    const input = overnightTaskInput(noBudget, "t-1", "s-1", {
      agent: { task: { maxSteps: 1000, maxCostUsd: 0 } },
    });
    expect(input).not.toHaveProperty("maxCostUsd");
  });

  it("takes agent.task.maxSteps from the loaded config", () => {
    const config = getConfig();
    const input = overnightTaskInput(args, "t-1", "s-1", config);
    expect(input.maxSteps).toBe(config.agent.task.maxSteps);
  });
});

describe("installStopSignals", () => {
  function setup() {
    const target = new EventEmitter();
    const runner = { cancel: vi.fn(), stop: vi.fn(async () => 0) };
    const exit = vi.fn();
    const handle = installStopSignals(runner, "t-1", {
      target: target as never,
      exit,
      write: () => undefined,
    });
    return { target, runner, exit, handle };
  }

  it("maps Ctrl+C to cancel and system signals to interrupt", () => {
    expect(OVERNIGHT_STOP_SIGNALS).toEqual({
      SIGINT: "cancel",
      SIGTERM: "interrupt",
      SIGHUP: "interrupt",
    });
  });

  it("SIGINT cancels the task", () => {
    const { target, runner, handle } = setup();
    target.emit("SIGINT");
    expect(runner.cancel).toHaveBeenCalledWith("t-1");
    expect(runner.stop).not.toHaveBeenCalled();
    expect(handle.interrupted()).toBe(false);
  });

  it.each(["SIGTERM", "SIGHUP"])("%s stops the runner without cancelling", (signal) => {
    const { target, runner, handle } = setup();
    target.emit(signal);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(handle.interrupted()).toBe(true);
  });

  it("a second signal quits at once, and dispose removes the listeners", () => {
    const { target, exit, handle } = setup();
    target.emit("SIGTERM");
    target.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(130);
    handle.dispose();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGHUP")).toBe(0);
  });
});

describe("unattendedDenial", () => {
  it("is an automatic decision with a system reason, not a person's no", () => {
    expect(unattendedDenial("a1")).toEqual({
      approvalId: "a1",
      approved: false,
      automatic: true,
      reason: expect.stringContaining("nobody is there"),
    });
  });
});
