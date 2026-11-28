import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

import { startCommandJob, type CommandJob } from "../../../sandbox/command-job.js";
import { JobMonitor, MONITOR_LINE_CHARS, type JobMonitorOptions } from "./shell-job-monitor.js";
import { rememberTypedSecret, resetTypedSecrets } from "./shell-job-secret.js";
import type { MonitorWake } from "./shell-monitor-wake.js";

/**
 * ATO-2436: a monitor keeps listening to a job after its call returned
 * and hands each batch of matching lines to `deliver`, with real
 * processes. Bounds: lines from before the monitor never count, one
 * notice per cooldown, a notice cap, a retry when nobody took it, and
 * one exit notice for a job that ended on its own.
 */

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("JobMonitor (ATO-2436)", () => {
  const started: CommandJob[] = [];
  const monitors: JobMonitor[] = [];
  function run(script: string): CommandJob {
    const job = startCommandJob("sh", ["-c", script], { cwd: tmpdir() });
    started.push(job);
    return job;
  }
  function monitor(
    job: CommandJob,
    raw: string,
    extra: Partial<JobMonitorOptions> = {},
  ): { monitor: JobMonitor; wakes: MonitorWake[] } {
    const wakes: MonitorWake[] = [];
    const m = new JobMonitor({
      sessionId: "s-monitor",
      jobId: 4,
      command: "npm run dev",
      until: raw,
      pattern: new RegExp(raw, "i"),
      job,
      deliver: (wake) => {
        wakes.push(wake);
        return true;
      },
      stillOwned: () => true,
      batchMs: 50,
      cooldownMs: 400,
      exitSettleMs: 20,
      ...extra,
    });
    monitors.push(m);
    return { monitor: m, wakes };
  }
  afterEach(() => {
    for (const m of monitors.splice(0)) m.close();
    for (const job of started.splice(0)) job.kill();
    resetTypedSecrets();
  });

  it("hides a value the user typed into a job, also across the line cut (ATO-2486, #2040 x #2107)", async () => {
    rememberTypedSecret("s-monitor", "letmein");
    const long = `${"x".repeat(MONITOR_LINE_CHARS - 5)}letmein`;
    const job = run(`sleep 0.2; echo 'token letmein'; echo '${long}'; sleep 30`);
    const { wakes } = monitor(job, "letmein");
    await until(() => wakes.length === 1);
    const text = wakes[0]!.text;
    expect(text).toContain("[secret hidden]");
    expect(text).not.toContain("letmein");
    expect(text).not.toContain("letme");
  });

  it("delivers a line printed after it started, not one printed before", async () => {
    const job = run("echo 'ready (old)'; sleep 0.4; echo booting; echo 'Ready on :3000'; sleep 30");
    await job.waitFor(200);
    const { monitor: m, wakes } = monitor(job, "ready");
    await until(() => wakes.length === 1);
    expect(wakes[0]).toMatchObject({ sessionId: "s-monitor", jobId: 4, lineCount: 1, exited: false });
    expect(wakes[0]!.text).toContain("Ready on :3000");
    expect(wakes[0]!.text).not.toContain("(old)");
    expect(wakes[0]!.text).toContain("not a message from the user");
    expect(m.active).toBe(true);
    expect(job.exited()).toBeNull();
  });

  it("batches quick matches into one notice and holds later ones for the cooldown", async () => {
    const job = run("sleep 0.2; echo 'error 1'; echo 'error 2'; echo 'error 3'; sleep 0.5; echo 'error 4'; sleep 30");
    const { wakes } = monitor(job, "error", { batchMs: 200, cooldownMs: 1_500 });
    await until(() => wakes.length === 1);
    expect(wakes[0]!.lineCount).toBe(3);
    await pause(500);
    // Line 4 came inside the cooldown: held, not delivered yet.
    expect(wakes).toHaveLength(1);
    await until(() => wakes.length === 2);
    expect(wakes[1]!.lineCount).toBe(1);
    expect(wakes[1]!.text).toContain("error 4");
  });

  it("stops after its last notice and says so", async () => {
    const job = run("sleep 0.2; echo 'ready'; sleep 0.6; echo 'ready again'; sleep 30");
    const { monitor: m, wakes } = monitor(job, "ready", { maxWakes: 1, cooldownMs: 50 });
    await until(() => wakes.length === 1);
    expect(wakes[0]!.text).toContain("last notice");
    expect(m.active).toBe(false);
    await pause(900);
    expect(wakes).toHaveLength(1);
  });

  it("keeps the lines and offers them again when nobody could take them", async () => {
    const job = run("sleep 0.2; echo 'ready'; sleep 30");
    let accept = false;
    const offered: MonitorWake[] = [];
    monitor(job, "ready", {
      cooldownMs: 300,
      deliver: (wake) => {
        offered.push(wake);
        return accept;
      },
    });
    await until(() => offered.length === 1);
    accept = true;
    await until(() => offered.length === 2);
    expect(offered[1]!.text).toContain("ready");
  });

  it("sends one exit notice when the job ends on its own", async () => {
    const job = run("sleep 0.2; echo 'Error: port in use'; exit 3");
    const { monitor: m, wakes } = monitor(job, "error", { batchMs: 2_000 });
    await until(() => wakes.length === 1);
    expect(wakes[0]).toMatchObject({ exited: true, lineCount: 1 });
    expect(wakes[0]!.text).toContain("exit 3");
    expect(wakes[0]!.text).toContain("port in use");
    expect(m.active).toBe(false);
  });

  it("says nothing at the exit of a job a wait or a kill already claimed", async () => {
    const job = run("sleep 0.2; exit 0");
    const { monitor: m, wakes } = monitor(job, "ready", { stillOwned: () => false });
    await job.waitFor(5_000);
    await until(() => !m.active);
    await pause(100);
    expect(wakes).toHaveLength(0);
  });

  it("delivers nothing after it was closed", async () => {
    const job = run("sleep 0.3; echo ready; sleep 30");
    const { monitor: m, wakes } = monitor(job, "ready");
    m.close();
    await pause(700);
    expect(wakes).toHaveLength(0);
  });
});
