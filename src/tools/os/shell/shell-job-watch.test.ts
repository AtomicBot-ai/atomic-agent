import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

import { startCommandJob, type CommandJob } from "../../../sandbox/command-job.js";
import {
  compileWatchPattern,
  JobLineWatch,
  WATCH_MAX_LINES,
} from "./shell-job-watch.js";

/**
 * ATO-2358: a job's output watched for a line, with real processes.
 * The watch sees what was printed before it existed, each match is
 * reported once, and the job's exit or the wait's end returns without
 * a match.
 */

function pattern(raw: string): RegExp {
  const compiled = compileWatchPattern(raw);
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.pattern;
}

describe("compileWatchPattern", () => {
  it("is case-insensitive and refuses an empty, an invalid or an overlong pattern", () => {
    expect(pattern("ready").test("Server READY on :3000")).toBe(true);
    expect(compileWatchPattern("").ok).toBe(false);
    expect(compileWatchPattern(5).ok).toBe(false);
    const bad = compileWatchPattern("(unclosed");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toContain("not a valid regular expression");
    expect(compileWatchPattern("a".repeat(501)).ok).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("JobLineWatch", () => {
  const started: CommandJob[] = [];
  function run(script: string): CommandJob {
    const job = startCommandJob("sh", ["-c", script], { cwd: tmpdir() });
    started.push(job);
    return job;
  }
  afterEach(() => {
    for (const job of started.splice(0)) job.kill();
  });

  it("matches a line printed after the wait began, and the job keeps running", async () => {
    const job = run("echo booting; sleep 0.3; echo 'compiled, Ready in 12ms'; sleep 30");
    const watch = new JobLineWatch(job);
    const outcome = await watch.waitForLine(pattern("ready"), 10_000);
    expect(outcome.kind).toBe("matched");
    if (outcome.kind !== "matched") return;
    expect(outcome.line).toEqual({ text: "compiled, Ready in 12ms", stream: "stdout" });
    expect(outcome.before.map((line) => line.text)).toEqual(["booting"]);
    expect(job.exited()).toBeNull();
  });

  it("matches a line printed before the watch existed", async () => {
    const job = run("echo 'listening on 3000'; sleep 30");
    await job.waitFor(500);
    const watch = new JobLineWatch(job);
    const outcome = await watch.waitForLine(pattern("listening"), 2_000);
    expect(outcome.kind).toBe("matched");
  });

  it("reports each match once: the next wait needs the next match", async () => {
    const job = run("echo 'error 1'; sleep 0.4; echo 'error 2'; sleep 30");
    const watch = new JobLineWatch(job);
    const first = await watch.waitForLine(pattern("error"), 5_000);
    expect(first.kind === "matched" && first.line.text).toBe("error 1");
    const second = await watch.waitForLine(pattern("error"), 5_000);
    expect(second.kind === "matched" && second.line.text).toBe("error 2");
    const third = await watch.waitForLine(pattern("error"), 300);
    expect(third.kind).toBe("elapsed");
  });

  it("watches stderr and an unterminated last line at the exit", async () => {
    const job = run("echo warn >&2; printf 'FAILED without newline'; exit 1");
    const watch = new JobLineWatch(job);
    const warn = await watch.waitForLine(pattern("^warn$"), 5_000);
    expect(warn.kind === "matched" && warn.line.stream).toBe("stderr");
    const failed = await watch.waitForLine(pattern("failed"), 5_000);
    expect(failed.kind === "matched" && failed.line.text).toBe("FAILED without newline");
  });

  it("returns exited when the job ends without a match, elapsed when the wait runs out", async () => {
    const quick = run("echo nothing here; exit 0");
    expect((await new JobLineWatch(quick).waitForLine(pattern("ready"), 5_000)).kind).toBe("exited");
    const slow = run("sleep 30");
    const t0 = Date.now();
    expect((await new JobLineWatch(slow).waitForLine(pattern("ready"), 300)).kind).toBe("elapsed");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("returns promptly when the signal aborts", async () => {
    const job = run("sleep 30");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const outcome = await new JobLineWatch(job).waitForLine(pattern("ready"), 0, controller.signal);
    expect(outcome.kind).toBe("aborted");
  });

  it("drops the oldest unread lines past the bound and says how many", async () => {
    const total = WATCH_MAX_LINES + 50;
    const job = run(`i=0; while [ $i -lt ${total} ]; do echo line $i; i=$((i+1)); done; echo DONE; sleep 30`);
    // Let it print everything before the first wait reads.
    await job.waitFor(1_500);
    const watch = new JobLineWatch(job);
    const outcome = await watch.waitForLine(pattern("^done$"), 5_000);
    expect(outcome.kind).toBe("matched");
    expect(outcome.dropped).toBeGreaterThan(0);
  });
});
