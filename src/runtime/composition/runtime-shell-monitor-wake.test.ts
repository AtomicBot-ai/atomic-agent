import { describe, expect, it } from "vitest";

import { ShellJobRegistry, type MonitorWake } from "../../tools/os/index.js";
import type { SessionState } from "../../session/session-state.js";
import type { TaskCreateInput } from "../../tasks/task-store.js";
import type { TaskRecord } from "../../tasks/task-types.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { installShellMonitorWake } from "./runtime-shell-monitor-wake.js";
import { channelGuestMetadata } from "../../session/channel-guest-session.js";

/**
 * ATO-2436, the runtime's path for a monitor notice: steer the turn
 * running on the session; otherwise file a one-shot task for it (the
 * heartbeat and file-trigger path, so the turn waits in the session's
 * FIFO). No task without tasks on, or for a session the store does not
 * know; the monitor then keeps the lines.
 */

const WAKE: MonitorWake = {
  sessionId: "s-wake",
  jobId: 3,
  command: "npm run dev",
  lineCount: 1,
  exited: false,
  text: "[Monitor on background job 3 (npm run dev): 1 new line matched \"ready\".]",
};

function harness(options: { steers: boolean; tasksEnabled?: boolean; known?: boolean; guest?: boolean }) {
  const jobs = new ShellJobRegistry();
  const created: TaskCreateInput[] = [];
  const steered: string[] = [];
  installShellMonitorWake({
    shellJobs: jobs,
    steer: (_sessionId, text) => {
      steered.push(text);
      return options.steers;
    },
    taskRunner: {
      create: (input: TaskCreateInput) => {
        created.push(input);
        return { id: `task-${created.length}` } as TaskRecord;
      },
    },
    sessionStore: {
      load: (id: string) =>
        options.known === false
          ? null
          : ({ id, metadata: options.guest === true ? channelGuestMetadata() : {} } as unknown as SessionState),
    },
    tasksEnabled: options.tasksEnabled ?? true,
    logger: new StructuredLogger({ level: "error", sinks: [] }),
  });
  return { jobs, created, steered };
}

describe("installShellMonitorWake", () => {
  it("steers a running turn and files no task", () => {
    const { jobs, created, steered } = harness({ steers: true });
    expect(jobs.wake.deliver(WAKE)).toBe(true);
    expect(steered).toEqual([WAKE.text]);
    expect(created).toHaveLength(0);
  });

  it("wakes an idle session with a one-shot task in that session", () => {
    const { jobs, created } = harness({ steers: false });
    expect(jobs.wake.deliver(WAKE)).toBe(true);
    expect(created).toEqual([
      expect.objectContaining({
        sessionId: "s-wake",
        userMessage: WAKE.text,
        origin: "agent",
        triggerSource: "agent",
        maxAttempts: 1,
      }),
    ]);
  });

  it("files nothing with tasks off or for a session the store does not know", () => {
    const off = harness({ steers: false, tasksEnabled: false });
    expect(off.jobs.wake.deliver(WAKE)).toBe(false);
    expect(off.created).toHaveLength(0);
    const unknown = harness({ steers: false, known: false });
    expect(unknown.jobs.wake.deliver(WAKE)).toBe(false);
    expect(unknown.created).toHaveLength(0);
  });

  it("never files a task for a channel's guest session; a running guest turn still hears it", () => {
    // A task turn would run without the guest's tool filter and read-only memory.
    const idle = harness({ steers: false, guest: true });
    expect(idle.jobs.wake.deliver(WAKE)).toBe(false);
    expect(idle.created).toHaveLength(0);
    const running = harness({ steers: true, guest: true });
    expect(running.jobs.wake.deliver(WAKE)).toBe(true);
    expect(running.created).toHaveLength(0);
  });
});
