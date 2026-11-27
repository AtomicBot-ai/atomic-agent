import { describe, expect, it } from "vitest";

import type { PluginMonitorList, StartablePluginMonitor } from "../../plugins/index.js";
import type { DeclaredMonitorSpec, DeclaredMonitorStart, ShellJobRecord } from "../../tools/os/index.js";
import { ShellJobRegistry } from "../../tools/os/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createPluginMonitorStarter } from "./runtime-plugin-monitors.js";
import { channelGuestMetadata } from "../../session/channel-guest-session.js";

/**
 * ATO-2438: plugin monitors start with a session's turn, once per
 * session; a monitor whose plugin went off is stopped; the session's end
 * lets it start again; a full chat is retried at the next turn.
 */

const MONITOR: StartablePluginMonitor = {
  plugin: "demo",
  name: "deploy",
  key: "demo/deploy",
  description: "Deployment status",
  command: "/plugins/demo/poll.sh",
  until: "ready",
};

const SESSION = { id: "s-1", workingDir: "/work" };

function harness() {
  const jobs = new ShellJobRegistry();
  let listed: PluginMonitorList = { monitors: [MONITOR], skipped: [] };
  const specs: DeclaredMonitorSpec[] = [];
  const stopped: Array<{ record: ShellJobRecord; reason: string }> = [];
  let next: DeclaredMonitorStart | null = null;
  let nextId = 1;
  jobs.stop = (record, reason) => {
    stopped.push({ record, reason });
    record.state = "killed";
    record.stopReason = reason;
    return true;
  };
  const starter = createPluginMonitorStarter({
    shellJobs: jobs,
    stateDir: "/state",
    logger: new StructuredLogger({ level: "error", sinks: [] }),
    list: () => listed,
    start: (_jobs, spec) => {
      specs.push(spec);
      if (next) {
        const result = next;
        next = null;
        return result;
      }
      const record = { id: nextId++, sessionId: spec.sessionId, state: "running", stopReason: null } as unknown as ShellJobRecord;
      return { ok: true, record };
    },
  });
  return {
    starter,
    specs,
    stopped,
    setListed: (value: PluginMonitorList) => { listed = value; },
    failNext: (result: DeclaredMonitorStart) => { next = result; },
  };
}

describe("createPluginMonitorStarter (ATO-2438)", () => {
  it("starts each monitor once per session, in the session's folder, naming the plugin", () => {
    const h = harness();
    h.starter.startFor(SESSION);
    h.starter.startFor(SESSION);
    expect(h.specs).toEqual([{
      sessionId: "s-1",
      cwd: "/work",
      commandLine: "/plugins/demo/poll.sh",
      until: "ready",
      label: "plugin demo: Deployment status",
      origin: 'the monitor "deploy" of plugin demo, which the user allowed to run code',
    }]);
    h.starter.startFor({ id: "s-2", workingDir: "/other" });
    expect(h.specs.map((s) => s.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("stops a running monitor once its plugin no longer offers it, and starts it again when it does", () => {
    const h = harness();
    h.starter.startFor(SESSION);
    h.setListed({ monitors: [], skipped: [{ plugin: "demo", name: "deploy", reason: "code off" }] });
    h.starter.startFor(SESSION);
    expect(h.stopped.map((s) => s.reason)).toEqual(["plugin_off"]);
    h.setListed({ monitors: [MONITOR], skipped: [] });
    h.starter.startFor(SESSION);
    expect(h.specs).toHaveLength(2);
  });

  it("does not bring back a monitor that exited or was stopped, except by the session's end", () => {
    const h = harness();
    const ended = (stopReason: string | null, state: string) =>
      ({ ok: true, record: { state, stopReason } as unknown as ShellJobRecord }) as DeclaredMonitorStart;
    // Stopped by the person with `/stop`: stays stopped.
    h.failNext(ended("user", "killed"));
    h.starter.startFor({ id: "s-user", workingDir: "/w" });
    h.starter.startFor({ id: "s-user", workingDir: "/w" });
    // Exited on its own: stays gone.
    h.failNext(ended(null, "exited"));
    h.starter.startFor({ id: "s-exit", workingDir: "/w" });
    h.starter.startFor({ id: "s-exit", workingDir: "/w" });
    expect(h.specs.map((s) => s.sessionId)).toEqual(["s-user", "s-exit"]);
    // Stopped by the session's end (`endSession`): starts with the chat's next turn.
    h.failNext(ended("session_end", "killed"));
    h.starter.startFor({ id: "s-end", workingDir: "/w" });
    h.starter.startFor({ id: "s-end", workingDir: "/w" });
    expect(h.specs.map((s) => s.sessionId)).toEqual(["s-user", "s-exit", "s-end", "s-end"]);
  });

  it("retries a chat that was full at the next turn; a monitor that cannot start is not retried", () => {
    const h = harness();
    h.failNext({ ok: false, reason: "full", retry: true });
    h.starter.startFor(SESSION);
    h.starter.startFor(SESSION);
    expect(h.specs).toHaveLength(2);
    h.failNext({ ok: false, reason: "bad pattern", retry: false });
    h.starter.startFor({ id: "s-4", workingDir: "/w" });
    h.starter.startFor({ id: "s-4", workingDir: "/w" });
    expect(h.specs).toHaveLength(3);
  });

  it("starts nothing for a channel's guest session", () => {
    const h = harness();
    h.starter.startFor({ id: "s-guest", workingDir: "/w", metadata: channelGuestMetadata() });
    expect(h.specs).toEqual([]);
    h.starter.startFor({ id: "s-owner", workingDir: "/w", metadata: {} });
    expect(h.specs.map((s) => s.sessionId)).toEqual(["s-owner"]);
  });

  it("forgets sessions the session's end reset, without starting anything twice", () => {
    const h = harness();
    for (let i = 0; i < 70; i += 1) {
      h.failNext({ ok: true, record: { state: "killed", stopReason: "session_end" } as unknown as ShellJobRecord });
      h.starter.startFor({ id: `s-${i}`, workingDir: "/w" });
    }
    h.starter.startFor(SESSION);
    h.starter.startFor(SESSION);
    expect(h.specs).toHaveLength(71);
  });

  it("never throws into the turn", () => {
    const jobs = new ShellJobRegistry();
    const logger = new StructuredLogger({ level: "error", sinks: [] });
    const throwingList = createPluginMonitorStarter({ shellJobs: jobs, stateDir: "/s", logger, list: () => { throw new Error("broken"); } });
    expect(() => throwingList.startFor(SESSION)).not.toThrow();
    const throwingStart = createPluginMonitorStarter({
      shellJobs: jobs, stateDir: "/s", logger,
      list: () => ({ monitors: [MONITOR], skipped: [] }),
      start: () => { throw new Error("spawn failed"); },
    });
    expect(() => throwingStart.startFor(SESSION)).not.toThrow();
  });
});
