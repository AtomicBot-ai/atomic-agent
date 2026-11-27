import { describe, expect, it } from "vitest";

import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { RunTurnResult } from "../agent/agent-loop.js";
import { createEmptySessionState, type SessionState } from "../session/session-state.js";
import { createBackgroundJobsControl, ShellJobRegistry, type MonitorWake } from "../tools/os/index.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";
import { formatMonitorWakeLine } from "./monitor-wake-line.js";

/**
 * ATO-2436, the TUI's half: a monitor notice for the open chat runs in
 * view, steering the running turn or starting the next one, under a line
 * that says which job woke it. A notice for another chat is left to the
 * runtime (steer or a queued task).
 */

const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

function wakeFor(sessionId: string): MonitorWake {
  return {
    sessionId,
    jobId: 2,
    command: "npm run dev",
    lineCount: 1,
    exited: false,
    text: "[Monitor on background job 2 (npm run dev): 1 new line matched \"ready\".]",
  };
}

function makeHarness() {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((action) => actions.push(action));
  const jobs = new ShellJobRegistry();
  const started: string[] = [];
  const steered: string[] = [];
  let steerable = false;
  const session: SessionState = createEmptySessionState({ id: "s-tui", workingDir: "/work" });
  let settle: ((result: RunTurnResult) => void) | null = null;
  const runtime = {
    createSession: () => session,
    getSessionWorkspace: () => null,
    skillRegistry: { listAll: () => [] },
    skillCatalog: [],
    skillCatalogDropped: 0,
    sessionStore: {
      listSummaryPage: () => [],
      countUnreadable: () => 0,
      listRecent: () => [],
      load: () => session,
    },
    approvals: { clearSessionGrants: () => undefined },
    config: {
      paths: {
        stateDir: "/nonexistent/atomic-agent-monitor-wake-test",
        userConfigFile: "/nonexistent/atomic-agent-monitor-wake-test/config.json",
      },
      skills: { projectTrust: [] },
    },
    steer: (_sessionId: string, text: string) => {
      steered.push(text);
      return steerable;
    },
    runTurn: (_session: SessionState, text: string) => {
      started.push(text);
      return new Promise<RunTurnResult>((resolve) => {
        settle = resolve;
      });
    },
    backgroundJobs: createBackgroundJobsControl(jobs),
  } as unknown as AgentRuntime;
  const chat = new ChatOrchestrator(runtime, bus, {
    maxSteps: 4,
    llamaUrl: "http://127.0.0.1:8080",
    readGateFacts: cloudGateFacts,
  });
  return {
    chat,
    jobs,
    actions,
    started,
    steered,
    setSteerable: (value: boolean) => {
      steerable = value;
    },
    finish: async () => {
      const resolve = settle;
      settle = null;
      resolve?.({ session, reason: "reply", stepCount: 1 } as RunTurnResult);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

const infoLines = (actions: readonly TuiAction[]) =>
  actions.flatMap((a) => (a.type === "runtime_info" ? [a.line] : []));

describe("ChatOrchestrator monitor notices (ATO-2436)", () => {
  it("starts the next turn in the open chat when it is idle, with a line saying why", async () => {
    const h = makeHarness();
    h.chat.sendMessage("start the dev server");
    await eventually(() => h.started.length === 1);
    await h.finish();
    const wake = wakeFor("s-tui");
    expect(h.jobs.wake.deliver(wake)).toBe(true);
    await eventually(() => h.started.length === 2);
    expect(h.started[1]).toBe(wake.text);
    expect(infoLines(h.actions)).toContain(formatMonitorWakeLine(wake));
  });

  it("steers the running turn instead of starting another", async () => {
    const h = makeHarness();
    h.chat.sendMessage("start the dev server");
    await eventually(() => h.started.length === 1);
    h.setSteerable(true);
    expect(h.jobs.wake.deliver(wakeFor("s-tui"))).toBe(true);
    expect(h.steered).toEqual([wakeFor("s-tui").text]);
    await h.finish();
    expect(h.started).toHaveLength(1);
  });

  it("leaves a notice for another chat, or before any chat exists, to the runtime", async () => {
    const h = makeHarness();
    let fellBack = 0;
    h.jobs.wake.setFallback(() => {
      fellBack += 1;
      return true;
    });
    expect(h.jobs.wake.deliver(wakeFor("s-tui"))).toBe(true);
    h.chat.sendMessage("hello");
    await eventually(() => h.started.length === 1);
    await h.finish();
    expect(h.jobs.wake.deliver(wakeFor("s-other"))).toBe(true);
    expect(fellBack).toBe(2);
    expect(h.started).toEqual(["hello"]);
  });
});

describe("formatMonitorWakeLine", () => {
  it("names the job and what happened", () => {
    expect(formatMonitorWakeLine({ ...wakeFor("s"), lineCount: 3, exited: true })).toBe(
      "background job 2 (npm run dev) printed 3 matching lines and exited; the agent is told (monitor)",
    );
  });
});
