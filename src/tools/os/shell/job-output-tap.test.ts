import { describe, expect, it } from "vitest";

import { readJobOutput } from "./job-output-tap.js";
import { hostFakeJob } from "./shell-job-host-test-helpers.js";

/**
 * ATO-2485: the desktop's terminal tab polls a job's output by position.
 * It must see what was printed before it first looked, every later piece
 * once, and be told when it fell behind what is held.
 */
describe("readJobOutput", () => {
  it("starts from what was printed before the first read, then follows new output", () => {
    const job = hostFakeJob({ snapshot: "Python 3.13\n>>> " });
    const first = readJobOutput(job, 0);
    expect(first).toEqual({ text: "Python 3.13\n>>> ", next: 16, dropped: false });

    job.print("2\n>>> ");
    const second = readJobOutput(job, first.next);
    expect(second).toEqual({ text: "2\n>>> ", next: 22, dropped: false });
    expect(readJobOutput(job, second.next)).toEqual({ text: "", next: 22, dropped: false });
  });

  it("says when the reader fell behind what the tap holds", () => {
    const job = hostFakeJob({ snapshot: "" });
    readJobOutput(job, 0, 10);
    job.print("0123456789abcdef");
    const late = readJobOutput(job, 0, 10);
    expect(late.text).toBe("6789abcdef");
    expect(late.next).toBe(16);
    expect(late.dropped).toBe(true);
  });

  it("reads a position it never gave out from the start of what is held", () => {
    const job = hostFakeJob({ snapshot: "abc" });
    expect(readJobOutput(job, 99)).toEqual({ text: "abc", next: 3, dropped: false });
    expect(readJobOutput(job, -1).text).toBe("abc");
    expect(readJobOutput(job, 1.5).text).toBe("abc");
  });

  it("marks a snapshot whose middle the job's own cap dropped", () => {
    const job = hostFakeJob({ snapshot: "head…tail", truncated: true });
    expect(readJobOutput(job, 0).dropped).toBe(true);
  });

  it("keeps the output of a job that ended, and stops listening", async () => {
    const job = hostFakeJob({ snapshot: "done\n" });
    readJobOutput(job, 0);
    job.finish({ exitCode: 0, signal: null, durationMs: 5 });
    await job.exit;
    job.print("late");
    expect(readJobOutput(job, 0).text).toBe("done\n");
  });
});
