import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDeclaredMonitor, type DeclaredMonitorSpec } from "./shell-declared-monitor.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import type { MonitorWake } from "./shell-monitor-wake.js";

/**
 * ATO-2438: a plugin's monitor runs as a kept job of the session with a
 * monitor on it from the start; its notice names the plugin. It never
 * pushes out the agent's own jobs, and needs something to take notices.
 */

const SESSION = "plugin-monitor-session";

describe.skipIf(process.platform === "win32")("startDeclaredMonitor (ATO-2438)", () => {
  let dir: string;
  let jobs: ShellJobRegistry;
  let wakes: MonitorWake[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-declared-monitor-"));
    jobs = new ShellJobRegistry({ maxJobs: 2 });
    wakes = [];
    jobs.wake.setFallback((wake) => {
      wakes.push(wake);
      return true;
    });
  });

  afterEach(async () => {
    jobs.endAll();
    await rm(dir, { recursive: true, force: true });
  });

  function spec(overrides: Partial<DeclaredMonitorSpec> = {}): DeclaredMonitorSpec {
    return {
      sessionId: SESSION,
      cwd: dir,
      commandLine: "sleep 0.3; echo deploy ready; echo; sleep 30",
      label: "plugin demo: Deployment status",
      origin: 'the monitor "deploy" of plugin demo',
      ...overrides,
    };
  }

  it("starts a kept job whose lines reach the session as a notice naming the plugin", async () => {
    const started = startDeclaredMonitor(jobs, spec());
    if (!started.ok) throw new Error(started.reason);
    expect(started.record).toMatchObject({ sessionId: SESSION, keep: true, state: "running" });
    expect(jobs.list(SESSION)).toEqual([started.record]);
    expect(started.record.monitor?.active).toBe(true);
    await waitFor(() => wakes.length > 0, 6_000);
    const wake = wakes[0]!;
    expect(wake).toMatchObject({ sessionId: SESSION, jobId: started.record.id, command: "plugin demo: Deployment status", lineCount: 1 });
    // Every non-blank line counts and the notice names no pattern; the blank line is not news.
    expect(wake.text).toContain(`[Monitor on background job ${started.record.id} (plugin demo: Deployment status): 1 new line.]`);
    expect(wake.text).toContain("deploy ready");
    expect(wake.text).toContain('automatic notice from the monitor "deploy" of plugin demo, not a message from the user');
  }, 10_000);

  it("keeps to the declared pattern", async () => {
    const started = startDeclaredMonitor(jobs, spec({ until: "READY" }));
    if (!started.ok) throw new Error(started.reason);
    expect(started.record.monitor?.until).toBe("READY");
    await waitFor(() => wakes.length > 0, 6_000);
    expect(wakes[0]!.text).toContain('1 new line matched "READY".');
  }, 10_000);

  it("does not push out the agent's jobs: with the session full it waits for a later turn", () => {
    expect(startDeclaredMonitor(jobs, spec({ commandLine: "sleep 30" })).ok).toBe(true);
    expect(startDeclaredMonitor(jobs, spec({ commandLine: "sleep 30" })).ok).toBe(true);
    const third = startDeclaredMonitor(jobs, spec({ commandLine: "sleep 30" }));
    expect(third).toEqual({ ok: false, reason: "the chat already runs 2 background jobs (at most 2)", retry: true });
    expect(jobs.list(SESSION).filter((r) => r.state === "running")).toHaveLength(2);
  });

  it("refuses a bad pattern, and a registry nothing can take notices from", () => {
    expect(startDeclaredMonitor(jobs, spec({ until: "(" }))).toMatchObject({ ok: false, retry: false });
    const bare = new ShellJobRegistry();
    expect(startDeclaredMonitor(bare, spec())).toEqual({ ok: false, reason: "nothing here can take monitor notices", retry: false });
    expect(bare.list(SESSION)).toEqual([]);
    expect(jobs.list(SESSION)).toEqual([]);
  });
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
