import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import type { MonitorWake } from "./shell-monitor-wake.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2436 through the tool: `{"monitor": id, "until"}` returns at once,
 * keeps the job across the turn's end, and a later matching line
 * reaches the session through the registry's wake router. A kill or
 * `{"monitor": id}` ends it; a registry nobody can wake refuses it.
 */

const SESSION = "monitor-session";

function shellTool(jobs: ShellJobRegistry) {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  // A short default wait: a command still running after it comes back
  // as an un-kept job, so a test can see the monitor keep it.
  return buildOsShellTool({ approvals: gate, approvalRequired: true, defaultTimeoutMs: 300, jobs });
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(process.platform === "win32")("os.shell.run monitor (ATO-2436)", () => {
  let dir: string;
  let jobs: ShellJobRegistry;
  let wakes: MonitorWake[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-monitor-"));
    jobs = new ShellJobRegistry();
    wakes = [];
  });

  afterEach(async () => {
    jobs.endAll();
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return { workingDir: dir, sessionId: SESSION, stepIndex: 0, signal: new AbortController().signal };
  }

  async function startJob(script: string): Promise<number> {
    const tool = shellTool(jobs);
    const started = await tool.run({ cmd: script }, ctx());
    const id = (started.details as { jobId?: number }).jobId;
    if (typeof id !== "number") throw new Error(`no job id: ${started.summary}`);
    return id;
  }

  it("returns at once, keeps the job past the turn's end and wakes the session on a later line", async () => {
    jobs.wake.setFallback((wake) => {
      wakes.push(wake);
      return true;
    });
    const tool = shellTool(jobs);
    const id = await startJob("echo booting; sleep 1.5; echo 'compiled: Ready in 9ms'; sleep 30");
    expect(jobs.get(SESSION, id)?.keep).toBe(false);
    const t0 = Date.now();
    const result = await tool.run({ monitor: id, until: "ready" }, ctx());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain(`monitoring job ${id}`);
    expect(result.details).toMatchObject({ jobId: id, monitor: { until: "ready" } });
    // The turn ends: a monitored job is kept, so it survives.
    expect(jobs.get(SESSION, id)?.keep).toBe(true);
    jobs.endTurn(SESSION);
    expect(jobs.get(SESSION, id)?.state).toBe("running");
    await until(() => wakes.length === 1);
    expect(wakes[0]).toMatchObject({ sessionId: SESSION, jobId: id, lineCount: 1 });
    expect(wakes[0]!.text).toContain("compiled: Ready in 9ms");
  });

  it("ends the monitor when the job is killed, and {monitor: id} turns it off", async () => {
    jobs.wake.setFallback((wake) => {
      wakes.push(wake);
      return true;
    });
    const tool = shellTool(jobs);
    const first = await startJob("sleep 1.5; echo ready; sleep 30");
    await tool.run({ monitor: first, until: "ready" }, ctx());
    const record = jobs.get(SESSION, first)!;
    const monitor = record.monitor!;
    expect(monitor.active).toBe(true);
    await tool.run({ kill: first }, ctx());
    expect(monitor.active).toBe(false);

    const second = await startJob("sleep 1.5; echo ready; sleep 30");
    await tool.run({ monitor: second, until: "ready" }, ctx());
    const off = await tool.run({ monitor: second }, ctx());
    expect(off.summary).toContain(`the monitor on job ${second}`);
    expect(off.summary).toContain("is off");
    expect(jobs.get(SESSION, second)?.monitor).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    expect(wakes).toHaveLength(0);
  }, 20_000);

  it("is refused where nothing can wake a session, and for a bad pattern", async () => {
    const tool = shellTool(jobs);
    const id = await startJob("sleep 30");
    const refused = await tool.run({ monitor: id, until: "ready" }, ctx());
    expect(refused.status).toBe("error");
    expect(refused.summary).toContain("monitors are not available here");
    expect(jobs.get(SESSION, id)?.monitor).toBeUndefined();

    jobs.wake.setFallback(() => true);
    const bad = await tool.run({ monitor: id, until: "(unclosed" }, ctx());
    expect(bad.status).toBe("error");
    expect(bad.summary).toContain("not a valid regular expression");
  });

  it("answers an unknown job id the way the other job forms do", async () => {
    jobs.wake.setFallback(() => true);
    const result = await shellTool(jobs).run({ monitor: 9, until: "ready" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ unknownJob: true, jobId: 9 });
  });
});
