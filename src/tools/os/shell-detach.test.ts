import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * F47 rework: at the operator's default timeout a command is detached,
 * not killed. The whole contract through the tool, with real processes:
 * the detached result, `wait`, `kill`, `jobs`, turn end vs `keep`, the
 * job limit, the ceiling — and that an explicit `timeoutMs` still kills.
 */

const SESSION = "test-session";

function shellTool(defaultTimeoutMs: number, jobs?: ShellJobRegistry) {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return buildOsShellTool({
    approvals: gate,
    approvalRequired: true,
    defaultTimeoutMs,
    ...(jobs === undefined ? {} : { jobs }),
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} is still alive`);
}

/**
 * The pid a command wrote, once it has: a shell takes ~200 ms to start
 * inside a loaded test worker, so the file is polled rather than read.
 */
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    try {
      const pid = Number((await readFile(file, "utf8")).trim());
      if (pid > 0) return pid;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${file} was never written`);
}

/** Every test's default wait; past the shell's startup on a loaded host. */
const DEFAULT_WAIT_MS = 1_000;

describe.skipIf(process.platform === "win32")(
  "os.shell.run detaches at the default timeout (F47)",
  () => {
    let dir: string;
    let jobs: ShellJobRegistry;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-detach-"));
      jobs = new ShellJobRegistry();
    });

    afterEach(async () => {
      // Whatever a test left running goes with its session.
      jobs.endAll();
      await rm(dir, { recursive: true, force: true });
    });

    function ctx(signal = new AbortController().signal): ToolContext {
      return { workingDir: dir, sessionId: SESSION, stepIndex: 0, signal };
    }

    it("returns ok with a job id, pid and the output so far; the process stays alive", async () => {
      const pidFile = join(dir, "pid");
      const result = await shellTool(DEFAULT_WAIT_MS, jobs).run(
        { cmd: `echo $$ > "${pidFile}"; echo partial; sleep 30` },
        ctx(),
      );
      expect(result.status).toBe("ok");
      expect(result.details).toMatchObject({
        detached: true,
        jobId: 1,
        timedOut: false,
        keep: false,
      });
      expect(result.summary).toContain(
        'still running after 1 s (job 1) — output so far below; os.shell.run {"wait": 1} keeps waiting (up to another 1 s per call), {"kill": 1} stops it, pass timeoutMs for a longer first wait',
      );
      expect(result.summary).toContain("still running (job 1, pid ");
      expect(result.summary).toContain("partial");
      const pid = await readPid(pidFile);
      expect(result.details.pid).toBe(pid);
      expect(isAlive(pid)).toBe(true);
    });

    it("wait returns the still-running result again, then the exit with the full output", async () => {
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      // Three seconds: past the first wait and the second, short of the third.
      const started = await tool.run(
        { cmd: "echo start; sleep 3; echo done; exit 4" },
        ctx(),
      );
      expect(started.details.detached).toBe(true);
      const again = await tool.run({ wait: 1 }, ctx());
      expect(again.status).toBe("ok");
      expect(again.details).toMatchObject({ detached: true, jobId: 1 });
      expect(again.summary).toContain("still running after another 1 s (job 1)");
      const finished = await tool.run({ wait: 1, timeoutMs: 10_000 }, ctx());
      expect(finished.status).toBe("error");
      expect(finished.details).toMatchObject({
        exitCode: 4,
        jobId: 1,
        timedOut: false,
      });
      expect(finished.details.detached).toBeUndefined();
      expect(finished.summary).toContain("exit: 4");
      expect(finished.summary).toContain("start");
      expect(finished.summary).toContain("done");
      // Collected: the id is gone.
      const gone = await tool.run({ wait: 1 }, ctx());
      expect(gone.status).toBe("error");
      expect(gone.summary).toContain("unknown job 1");
      expect(jobs.list(SESSION)).toEqual([]);
    });

    it("kill stops the whole group and reports the tail", async () => {
      const pidFile = join(dir, "background.pid");
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      await tool.run(
        { cmd: `sleep 30 & echo $! > "${pidFile}"; echo tail-line; sleep 30` },
        ctx(),
      );
      const pid = await readPid(pidFile);
      expect(isAlive(pid)).toBe(true);
      const killed = await tool.run({ kill: 1 }, ctx());
      expect(killed.status).toBe("ok");
      expect(killed.details).toMatchObject({
        killed: true,
        jobId: 1,
        stopReason: "kill",
      });
      expect(killed.summary).toContain("killed (job 1, on request)");
      expect(killed.summary).toContain("tail-line");
      await waitForExit(pid);
      expect(jobs.list(SESSION)).toEqual([]);
    });

    it("jobs lists this session's jobs with their state", async () => {
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      expect((await tool.run({ jobs: true }, ctx())).summary).toContain(
        "no jobs in this session",
      );
      await tool.run({ cmd: "sleep 30", keep: true }, ctx());
      await tool.run({ cmd: "sleep 30" }, ctx());
      const listed = await tool.run({ jobs: true }, ctx());
      expect(listed.status).toBe("ok");
      expect(listed.summary).toMatch(/job 1: sleep 30 — running \d+ s, kept \(pid \d+\)/);
      expect(listed.summary).toMatch(/job 2: sleep 30 — running \d+ s \(pid \d+\)/);
      const rows = listed.details.jobs as Array<Record<string, unknown>>;
      expect(rows.map((row) => [row.id, row.state, row.keep])).toEqual([
        [1, "running", true],
        [2, "running", false],
      ]);
    });

    it("the turn's end kills un-kept jobs; keep: true on the call or on a later wait survives it", async () => {
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      const plainPid = join(dir, "plain.pid");
      const keptPid = join(dir, "kept.pid");
      const laterPid = join(dir, "later.pid");
      await tool.run({ cmd: `echo $$ > "${plainPid}"; sleep 30` }, ctx());
      await tool.run({ cmd: `echo $$ > "${keptPid}"; sleep 30`, keep: true }, ctx());
      await tool.run({ cmd: `echo $$ > "${laterPid}"; sleep 30` }, ctx());
      await tool.run({ wait: 3, keep: true }, ctx());
      const [plain, kept, later] = await Promise.all(
        [plainPid, keptPid, laterPid].map(readPid),
      );
      jobs.endTurn(SESSION);
      await waitForExit(plain!);
      expect(isAlive(kept!)).toBe(true);
      expect(isAlive(later!)).toBe(true);
      expect(jobs.list(SESSION).map((r) => r.id)).toEqual([2, 3]);
      jobs.endSession(SESSION);
      await waitForExit(kept!);
      await waitForExit(later!);
    });

    it("at maxJobs the next detach stops the oldest un-kept job and says so", async () => {
      jobs = new ShellJobRegistry({ maxJobs: 1 });
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      const firstPid = join(dir, "first.pid");
      await tool.run({ cmd: `echo $$ > "${firstPid}"; sleep 30` }, ctx());
      const first = await readPid(firstPid);
      const second = await tool.run({ cmd: "sleep 30" }, ctx());
      expect(second.details).toMatchObject({ detached: true, jobId: 2, evictedJobId: 1 });
      expect(second.summary).toContain(
        "job 1 (echo $$ >",
      );
      expect(second.summary).toContain(
        "was stopped to stay within 1 running jobs — the oldest un-kept job",
      );
      await waitForExit(first);
      expect(jobs.get(SESSION, 1)?.state).toBe("killed");
      expect(jobs.get(SESSION, 2)?.state).toBe("running");
    });

    it("jobMaxMs is an absolute ceiling from the start; a later wait reports the stop", async () => {
      // The ceiling is two seconds from the spawn: one past the detach.
      jobs = new ShellJobRegistry({ jobMaxMs: 2_000 });
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      const pidFile = join(dir, "pid");
      await tool.run({ cmd: `echo $$ > "${pidFile}"; sleep 30`, keep: true }, ctx());
      const pid = await readPid(pidFile);
      await waitForExit(pid);
      const collected = await tool.run({ wait: 1, timeoutMs: 10_000 }, ctx());
      expect(collected.status).toBe("ok");
      expect(collected.details).toMatchObject({ killed: true, stopReason: "ceiling" });
      expect(collected.summary).toContain("killed (job 1, at the job ceiling)");
    });

    it("an explicit timeoutMs still kills the group, and registers no job", async () => {
      const pidFile = join(dir, "background.pid");
      const result = await shellTool(600_000, jobs).run(
        { cmd: `sleep 30 & echo $! > "${pidFile}"; sleep 30`, timeoutMs: 1_500 },
        ctx(),
      );
      expect(result.status).toBe("error");
      expect(result.details).toMatchObject({
        timedOut: true,
        timeoutMs: 1_500,
        source: "explicit",
      });
      expect(result.details.detached).toBeUndefined();
      expect(result.summary).toContain("stopped after 1.5 s (timeoutMs)");
      await waitForExit(await readPid(pidFile));
      expect(jobs.list(SESSION)).toEqual([]);
    });

    it("a cancelled turn does not wait on a wait: it returns at once and the job keeps running", async () => {
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      const pidFile = join(dir, "pid");
      await tool.run({ cmd: `echo $$ > "${pidFile}"; sleep 30` }, ctx());
      const controller = new AbortController();
      const pending = tool.run({ wait: 1, timeoutMs: 0 }, ctx(controller.signal));
      setTimeout(() => controller.abort(), 100);
      const startedAt = Date.now();
      const result = await pending;
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.details).toMatchObject({ detached: true, jobId: 1 });
      expect(isAlive(await readPid(pidFile))).toBe(true);
    });

    it("refuses a call that mixes forms, a wait that is not a job id, and an unknown job", async () => {
      const tool = shellTool(DEFAULT_WAIT_MS, jobs);
      const mixed = await tool.run({ cmd: "ls", wait: 1 }, ctx());
      expect(mixed.status).toBe("error");
      expect(mixed.summary).toContain("pass one of cmd, wait, kill, jobs (got cmd, wait)");
      const bad = await tool.run({ wait: "soon" }, ctx());
      expect(bad.status).toBe("error");
      expect(bad.summary).toContain("wait must be a job id");
      const unknown = await tool.run({ kill: 9 }, ctx());
      expect(unknown.status).toBe("error");
      expect(unknown.summary).toContain("unknown job 9 in this session");
      // No form at all is the pre-existing `cmd` refusal.
      await expect(tool.run({}, ctx())).rejects.toThrow(/`cmd` must be a non-empty string/);
    });
  },
);
