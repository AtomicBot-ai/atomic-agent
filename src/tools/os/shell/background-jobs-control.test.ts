import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { createBackgroundJobsControl } from "./background-jobs-control.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2437: what `/ps` and `/stop` see and do, on a real registry. The
 * list is the session's own jobs; a stop by the person leaves the record
 * so the agent's next `wait` reads that the user stopped it.
 */

const SESSION = "ps-session";

describe.skipIf(process.platform === "win32")("createBackgroundJobsControl (ATO-2437)", () => {
  let dir: string;
  let jobs: ShellJobRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-ps-"));
    jobs = new ShellJobRegistry();
  });

  afterEach(async () => {
    jobs.endAll();
    await rm(dir, { recursive: true, force: true });
  });

  function tool() {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return buildOsShellTool({ approvals: gate, approvalRequired: true, defaultTimeoutMs: 300, jobs });
  }

  function ctx(sessionId = SESSION): ToolContext {
    return { workingDir: dir, sessionId, stepIndex: 0, signal: new AbortController().signal };
  }

  async function start(cmd: string, sessionId = SESSION): Promise<number> {
    const result = await tool().run({ cmd }, ctx(sessionId));
    const id = (result.details as { jobId?: number }).jobId;
    if (typeof id !== "number") throw new Error(`no job id: ${result.summary}`);
    return id;
  }

  it("lists the session's own jobs, with the monitor pattern", async () => {
    jobs.wake.setFallback(() => true);
    const id = await start("sleep 30");
    await start("sleep 30", "another-session");
    await tool().run({ monitor: id, until: "ready" }, ctx());
    const control = createBackgroundJobsControl(jobs);
    const list = control.list(SESSION);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, command: "sleep 30", state: "running", keep: true, monitor: "ready" });
    expect(list[0]!.elapsedMs).toBeGreaterThan(0);
  });

  it("stops one job for the person; the agent's wait says the user stopped it", async () => {
    const id = await start("sleep 30");
    const control = createBackgroundJobsControl(jobs);
    expect(control.stop(SESSION, id)).toBe(true);
    expect(control.stop(SESSION, id)).toBe(false);
    expect(control.stop("another-session", id)).toBe(false);
    expect(control.list(SESSION)[0]).toMatchObject({ state: "killed", stopReason: "user" });
    const collected = await tool().run({ wait: id }, ctx());
    expect(collected.summary).toContain("by the user");
  });

  it("stops every running job of the session and counts them", async () => {
    await start("sleep 30");
    await start("sleep 30");
    const other = await start("sleep 30", "another-session");
    const control = createBackgroundJobsControl(jobs);
    expect(control.stopAll(SESSION)).toBe(2);
    expect(control.stopAll(SESSION)).toBe(0);
    expect(jobs.get("another-session", other)?.state).toBe("running");
  });
});
