import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2358 through the tool: `until` with a command starts it as a kept
 * background job and comes back at the first matching line; with a
 * `wait` it watches a job. Without it, the job forms behave as before.
 */

const SESSION = "until-session";

function shellTool(jobs: ShellJobRegistry) {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return buildOsShellTool({
    approvals: gate,
    approvalRequired: true,
    defaultTimeoutMs: 5_000,
    jobs,
  });
}

describe.skipIf(process.platform === "win32")("os.shell.run until (ATO-2358)", () => {
  let dir: string;
  let jobs: ShellJobRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-until-"));
    jobs = new ShellJobRegistry();
  });

  afterEach(async () => {
    jobs.endAll();
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(signal = new AbortController().signal): ToolContext {
    return { workingDir: dir, sessionId: SESSION, stepIndex: 0, signal };
  }

  it("{cmd, until} returns at the matching line, long before the default wait, as a kept job", async () => {
    const tool = shellTool(jobs);
    const t0 = Date.now();
    const result = await tool.run(
      { cmd: "echo booting; sleep 0.3; echo 'server ready on :3000'; sleep 30", until: "ready" },
      ctx(),
    );
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({
      detached: true,
      matched: true,
      until: "ready",
      matchedLine: "server ready on :3000",
      jobId: 1,
      keep: true,
    });
    expect(result.summary).toContain('job 1 printed a line matching /ready/: "server ready on :3000"');
    expect(result.summary).toContain('{"wait": 1, "until": "ready"} waits for the next match');
    const [record] = jobs.list(SESSION);
    expect(record?.state).toBe("running");
    // Kept: the turn's end does not take it.
    jobs.endTurn(SESSION);
    expect(jobs.list(SESSION).map((r) => r.id)).toEqual([1]);
  });

  it("{wait, until} watches a job the default timeout detached, then the next match", async () => {
    const tool = shellTool(jobs);
    const started = await tool.run(
      { cmd: "sleep 0.2; echo 'step 1 ok'; sleep 0.5; echo 'ERROR: disk full'; sleep 30", background: true },
      ctx(),
    );
    expect(started.details.detached).toBe(true);
    // printed during the 3 s background watch, before this wait: still matched
    const ok = await tool.run({ wait: 1, until: "ok$" }, ctx());
    expect(ok.details).toMatchObject({ matched: true, matchedLine: "step 1 ok" });
    const err = await tool.run({ wait: 1, until: "error" }, ctx());
    expect(err.details).toMatchObject({ matched: true, matchedLine: "ERROR: disk full" });
    const none = await tool.run({ wait: 1, until: "error", timeoutMs: 400 }, ctx());
    expect(none.status).toBe("ok");
    expect(none.details).toMatchObject({ detached: true, jobId: 1 });
    expect(none.details.matched).toBeUndefined();
    expect(none.summary).toContain("no line of job 1 matched /error/ within 0.4 s");
  });

  it("a job that exits without a match is collected with the reason", async () => {
    const tool = shellTool(jobs);
    await tool.run({ cmd: "sleep 30", background: true }, ctx());
    jobs.list(SESSION)[0]!.job.stop();
    const result = await tool.run({ wait: 1, until: "ready" }, ctx());
    expect(result.details.matched).toBeUndefined();
    expect(jobs.list(SESSION)).toEqual([]);
  });

  it("{cmd, until} on a command that exits first returns its exit and says no line matched", async () => {
    const tool = shellTool(jobs);
    const result = await tool.run({ cmd: "echo compile failed; exit 2", until: "ready" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ exitCode: 2 });
    expect(result.summary).toContain("the job exited without printing a line matching /ready/");
    expect(jobs.list(SESSION)).toEqual([]);
  });

  // Review round 1: a match only seen at the exit (an unterminated last
  // line) must be reported as an exit, not as a running job.
  it("a job that prints the line and then exits is collected, not reported running", async () => {
    const tool = shellTool(jobs);
    const result = await tool.run({ cmd: "sleep 0.2; printf 'build ready'; exit 0", until: "ready" }, ctx());
    expect(result.details.matched).toBeUndefined();
    expect(result.details).toMatchObject({ exitCode: 0, jobId: 1 });
    expect(result.summary).toContain('the job printed a line matching /ready/: "build ready", then exited');
    expect(result.summary).not.toContain("It is still running");
    expect(jobs.list(SESSION)).toEqual([]);
  });

  // Review round 1: {cmd, until} keeps the eviction line a plain
  // background start shows.
  it("{cmd, until} says which job it evicted to stay within the job limit", async () => {
    const limited = new ShellJobRegistry({ maxJobs: 1 });
    try {
      const tool = shellTool(limited);
      await tool.run({ cmd: "sleep 30", background: true }, ctx());
      const result = await tool.run({ cmd: "echo up; sleep 30", until: "up" }, ctx());
      expect(result.details).toMatchObject({ matched: true, jobId: 2 });
      expect(result.summary).toContain("job 1 (sleep 30) was stopped to stay within 1 running jobs");
    } finally {
      limited.endAll();
    }
  });

  it("refuses a bad pattern before anything runs", async () => {
    const tool = shellTool(jobs);
    const marker = join(dir, "ran");
    const result = await tool.run({ cmd: `touch "${marker}"`, until: "(" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("not a valid regular expression");
    expect(jobs.list(SESSION)).toEqual([]);
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });
});
