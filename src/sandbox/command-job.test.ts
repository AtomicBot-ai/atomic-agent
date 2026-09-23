import { describe, expect, it } from "vitest";

import {
  awaitJobExit,
  JOB_STOP_GRACE_MS,
  startCommandJob,
} from "./command-job.js";

/**
 * The primitive behind `os.shell.run`'s detached jobs: output captured
 * across waits, a stop that takes the whole process group. POSIX only:
 * on Windows the group is a tree-kill, pinned in
 * command-runner-kill.test.ts.
 */

const cwd = process.cwd();

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} survived the stop`);
}

describe.skipIf(process.platform === "win32")("startCommandJob", () => {
  it("captures both streams and reports the exit", async () => {
    const job = startCommandJob("sh", ["-c", "echo one; echo err >&2; exit 3"], {
      cwd,
    });
    expect(await job.waitFor(5_000)).toBe("exited");
    expect(job.exited()).toMatchObject({ exitCode: 3, signal: null });
    expect(job.output().stdout).toContain("one");
    expect(job.output().stderr).toContain("err");
  });

  it("a wait that elapses leaves the job running; a later wait sees the exit and the output since", async () => {
    // A shell takes ~200 ms to start inside a loaded test worker, so the
    // first wait is well past that and the sleep well past the wait.
    const job = startCommandJob("sh", ["-c", "echo early; sleep 2.5; echo late"], {
      cwd,
    });
    expect(await job.waitFor(1_000)).toBe("elapsed");
    expect(job.exited()).toBeNull();
    expect(job.output().stdout).toContain("early");
    expect(job.output().stdout).not.toContain("late");
    expect(await job.waitFor(10_000)).toBe("exited");
    expect(job.output().stdout).toContain("late");
    expect(job.exited()?.exitCode).toBe(0);
  });

  it("an aborted wait returns at once and leaves the job running", async () => {
    const controller = new AbortController();
    const job = startCommandJob("sleep", ["30"], { cwd });
    setTimeout(() => controller.abort(), 100);
    expect(await job.waitFor(0, controller.signal)).toBe("aborted");
    expect(job.exited()).toBeNull();
    job.kill();
    expect((await awaitJobExit(job)).signal).toBe("SIGKILL");
  });

  it("stop takes a subshell's background child with it", async () => {
    const job = startCommandJob("sh", ["-c", "sleep 30 & echo $!; sleep 30"], {
      cwd,
    });
    // Long enough for the shell to have run `echo` on a loaded host.
    await job.waitFor(1_500);
    const pid = Number(job.output().stdout.trim());
    expect(pid).toBeGreaterThan(0);
    job.stop();
    const exit = await awaitJobExit(job);
    expect(exit.signal).toBe("SIGTERM");
    // Without the group the orphaned `sleep` would keep stdout open and
    // the exit would not close for 30 s.
    expect(exit.durationMs).toBeLessThan(5_000);
    await waitForExit(pid);
  });

  it("escalates to SIGKILL after the grace when the group ignores SIGTERM", async () => {
    // `trap "" TERM` is inherited across exec, so nothing in the group
    // honours the polite stop.
    const job = startCommandJob("sh", ["-c", 'trap "" TERM; sleep 30'], { cwd });
    // Long enough for the trap to be in place on a loaded host.
    await job.waitFor(1_000);
    const stoppedAt = Date.now();
    job.stop();
    const exit = await awaitJobExit(job);
    expect(exit.signal).toBe("SIGKILL");
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(JOB_STOP_GRACE_MS - 50);
  }, 10_000);

  it("rejects the first wait when the command cannot be spawned", async () => {
    const job = startCommandJob("/nonexistent/definitely-missing-binary", [], {
      cwd,
    });
    await expect(job.waitFor(1_000)).rejects.toThrow(/ENOENT/);
  });

  it("caps the output per stream, keeping the head and the tail", async () => {
    const job = startCommandJob(
      "sh",
      ["-c", "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done"],
      { cwd, maxOutputBytes: 2_000 },
    );
    expect(await job.waitFor(10_000)).toBe("exited");
    const out = job.output();
    expect(out.truncated).toBe(true);
    expect(out.stdout).toContain("line0\n");
    expect(out.stdout).toContain("line1999");
    expect(out.stdout).toContain("bytes dropped");
  });
});
