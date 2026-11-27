import { describe, expect, it } from "vitest";

import { createShellJobHostControls, SHELL_JOB_INPUT_MAX_CHARS } from "./shell-job-host.js";
import { hostFacts, hostFakeJob } from "./shell-job-host-test-helpers.js";
import { listShellJobs } from "./shell-job-calls.js";
import { ShellJobRegistry } from "./shell-jobs.js";

/**
 * ATO-2485: the person's side of the agent's kept jobs. The host reaches
 * a job by session and id only, types into an interactive one without
 * any tool call, and a stop it makes reads as the user's to the model.
 */
function setup(options: { stdinOpen?: boolean; snapshot?: string } = {}) {
  const registry = new ShellJobRegistry();
  const job = hostFakeJob(options);
  const { record } = registry.register("s-1", job, hostFacts("python3 -i"), true);
  return { registry, job, record, host: createShellJobHostControls(registry) };
}

describe("createShellJobHostControls", () => {
  it("lists a session's jobs with what the host needs to draw a tab", () => {
    const { host } = setup();
    expect(host.list("s-1")).toEqual([
      {
        id: 1,
        commandLine: "python3 -i",
        cwd: "/work",
        state: "running",
        interactive: true,
        resizable: false,
        startedAt: 1_700_000_000_000,
        exitCode: null,
        signal: null,
      },
    ]);
    expect(host.list("s-other")).toEqual([]);
  });

  it("does not offer input to a job whose stdin is closed (a plain background job)", () => {
    const { host } = setup({ stdinOpen: false });
    expect(host.list("s-1")[0]!.interactive).toBe(false);
    expect(host.write("s-1", 1, "y\n")).toBe("closed");
  });

  it("types the person's text into the job, and nothing else sees it", () => {
    const { host, job, record } = setup();
    expect(host.write("s-1", 1, "hunter2\n")).toBe("written");
    expect(job.typed.filter((t) => t.length > 0)).toEqual(["hunter2\n"]);
    // Not a tool call: no watch, no stop reason, the job is still the model's.
    expect(record.lineWatch).toBeUndefined();
    expect(record.state).toBe("running");
  });

  it("closes stdin on eof", () => {
    const { host, job } = setup();
    expect(host.write("s-1", 1, "", true)).toBe("written");
    expect(job.ended).toBe(true);
    expect(host.list("s-1")[0]!.interactive).toBe(false);
  });

  it("refuses a job of another session and an oversized write", () => {
    const { host, job } = setup();
    expect(host.write("s-2", 1, "x\n")).toBe("not_found");
    expect(host.read("s-2", 1, 0)).toBeNull();
    expect(host.write("s-1", 1, "x".repeat(SHELL_JOB_INPUT_MAX_CHARS + 1))).toBe("too_long");
    expect(job.typed.filter((t) => t.length > 0)).toEqual([]);
  });

  it("reads output with the job's current state", () => {
    const { host, job } = setup({ snapshot: ">>> " });
    const first = host.read("s-1", 1, 0)!;
    expect(first.text).toBe(">>> ");
    job.print("4\n");
    const next = host.read("s-1", 1, first.next)!;
    expect(next.text).toBe("4\n");
    expect(next.job.state).toBe("running");
  });

  it("says a terminal without a size control cannot be resized", () => {
    const { host } = setup();
    expect(host.resize("s-1", 1, 120, 40)).toBe("not_supported");
    expect(host.resize("s-1", 9, 120, 40)).toBe("not_found");
  });

  it("resizes a backend that can (a native pty)", () => {
    const { host, job } = setup();
    const sizes: number[][] = [];
    Object.assign(job, { resize: (cols: number, rows: number) => sizes.push([cols, rows]) });
    expect(host.list("s-1")[0]!.resizable).toBe(true);
    expect(host.resize("s-1", 1, 100, 30)).toBe("resized");
    expect(sizes).toEqual([[100, 30]]);
  });

  it("stops a job as the user, and the model is told so", () => {
    const { host, job, record, registry } = setup();
    expect(host.stop("s-1", 1)).toBe("stopped");
    expect(job.stops).toBe(1);
    expect(record.stopReason).toBe("person");
    expect(host.stop("s-1", 1)).toBe("not_running");
    const seen = listShellJobs({ jobs: registry, sessionId: "s-1", defaultTimeoutMs: 0, signal: new AbortController().signal });
    expect(seen.summary).toContain("stopped by the user");
  });
});
