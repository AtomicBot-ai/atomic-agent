import { describe, expect, it } from "vitest";

import type { BackgroundJobsControl, BackgroundJobView } from "../../tools/os/index.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";
import {
  formatBackgroundJobs,
  parsePsCommand,
  parseStopCommand,
  runBackgroundJobsCommand,
} from "./ps-command.js";

/** ATO-2437: `/ps` lists this chat's background jobs, `/stop` ends one or all. */

function view(overrides: Partial<BackgroundJobView>): BackgroundJobView {
  return {
    id: 1,
    command: "npm run dev",
    state: "running",
    keep: true,
    pid: 4242,
    elapsedMs: 125_000,
    exitCode: null,
    signal: null,
    stopReason: null,
    monitor: null,
    ...overrides,
  };
}

function control(jobs: BackgroundJobView[]): BackgroundJobsControl & { stopped: number[] } {
  const stopped: number[] = [];
  return {
    stopped,
    onMonitorWake: () => () => undefined,
    list: () => jobs,
    stop: (_sessionId, id) => {
      const job = jobs.find((j) => j.id === id && j.state === "running");
      if (!job) return false;
      stopped.push(id);
      return true;
    },
    stopAll: () => jobs.filter((j) => j.state === "running").length,
  };
}

describe("/ps and /stop parsing", () => {
  it("routes /ps and /stop through the slash handler", () => {
    expect(dispatchSlashCommand("/ps").backgroundJobsCommand).toEqual({ kind: "list" });
    expect(dispatchSlashCommand("/stop").backgroundJobsCommand).toEqual({ kind: "stop_all" });
    expect(dispatchSlashCommand("/stop 3").backgroundJobsCommand).toEqual({ kind: "stop", id: 3 });
    const bad = dispatchSlashCommand("/stop three");
    expect(bad.backgroundJobsCommand).toBeUndefined();
    expect(bad.systemMessage).toContain("usage: /stop");
  });

  it("reads ids, #ids and all; refuses anything else", () => {
    expect(parseStopCommand("#2")).toEqual({ ok: true, command: { kind: "stop", id: 2 } });
    expect(parseStopCommand("all")).toEqual({ ok: true, command: { kind: "stop_all" } });
    expect(parseStopCommand("0").ok).toBe(false);
    expect(parsePsCommand("now").ok).toBe(false);
  });
});

describe("formatBackgroundJobs", () => {
  it("shows each job's command, state, kept flag and monitor, then the next step", () => {
    const text = formatBackgroundJobs([
      view({ monitor: "ready|error" }),
      view({ id: 2, command: "make test", state: "exited", keep: false, exitCode: 1, elapsedMs: 31_000 }),
      view({ id: 3, command: "tail -f log", state: "killed", stopReason: "user", elapsedMs: 4_000 }),
    ]);
    expect(text).toBe(
      [
        "background jobs in this chat:",
        '  job 1  npm run dev  running 2 min, kept, monitor "ready|error"',
        "  job 2  make test  finished (exit 1) after 31 s",
        "  job 3  tail -f log  stopped by you after 4 s",
        "/stop <id> stops one | /stop stops every running one",
      ].join("\n"),
    );
  });

  it("says when there are none", () => {
    expect(formatBackgroundJobs([])).toBe("no background jobs in this chat");
  });
});

describe("runBackgroundJobsCommand", () => {
  it("stops one job, says when it is not running or unknown", () => {
    const jobs = control([view({}), view({ id: 2, state: "exited", exitCode: 0 })]);
    expect(runBackgroundJobsCommand({ kind: "stop", id: 1 }, "s", jobs)).toBe(
      "stopped background job 1; the agent sees that you stopped it",
    );
    expect(jobs.stopped).toEqual([1]);
    expect(runBackgroundJobsCommand({ kind: "stop", id: 2 }, "s", jobs)).toBe("background job 2 is not running");
    expect(runBackgroundJobsCommand({ kind: "stop", id: 9 }, "s", jobs)).toContain("no background job 9");
  });

  it("stops all and counts them; nothing to do without a chat or a runtime", () => {
    expect(runBackgroundJobsCommand({ kind: "stop_all" }, "s", control([view({}), view({ id: 2 })]))).toContain(
      "stopped 2 background jobs",
    );
    expect(runBackgroundJobsCommand({ kind: "stop_all" }, "s", control([]))).toBe(
      "no running background jobs in this chat",
    );
    expect(runBackgroundJobsCommand({ kind: "list" }, null, control([view({})]))).toBe(
      "no background jobs in this chat",
    );
    expect(runBackgroundJobsCommand({ kind: "list" }, "s", undefined)).toBe("no background jobs in this chat");
  });
});
