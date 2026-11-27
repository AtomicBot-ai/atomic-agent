import { listPluginMonitors, type PluginMonitorList } from "../../plugins/index.js";
import {
  startDeclaredMonitor,
  type DeclaredMonitorSpec,
  type DeclaredMonitorStart,
  type ShellJobRecord,
  type ShellJobRegistry,
} from "../../tools/os/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * Plugin monitors (ATO-2438, after Claude Code's plugin `monitors`): the
 * background commands enabled plugins declare start with a session's
 * first turn in this process, each as a kept job of that session with a
 * monitor on it, so a line it prints reaches the agent the way a monitor
 * the agent set does (`installShellMonitorWake`). Only plugins the user
 * allowed to run code start any (`listPluginMonitors`).
 *
 * Each monitor starts once per session and process. One that exited,
 * that the agent or the person stopped, or that lost its slot does not
 * come back by itself; one the session's end stopped starts again when
 * the chat is used again; one that could not start because the chat
 * already ran `maxJobs` jobs is tried at the next turn. On every turn, a
 * running monitor whose plugin is off, removed, switched off for that
 * monitor or no longer allowed to run code is stopped.
 */

export interface PluginMonitorStarter {
  /** Called as a turn of `session` starts (not for subagent or Fusion workers). */
  startFor(session: { id: string; workingDir: string }): void;
}

export function createPluginMonitorStarter(deps: {
  shellJobs: ShellJobRegistry;
  stateDir: string;
  logger: StructuredLogger;
  envPassthrough?: () => readonly string[];
  /** Test seams. */
  list?: (stateDir: string) => PluginMonitorList;
  start?: (jobs: ShellJobRegistry, spec: DeclaredMonitorSpec) => DeclaredMonitorStart;
}): PluginMonitorStarter {
  const list = deps.list ?? ((stateDir) => listPluginMonitors(stateDir));
  const start = deps.start ?? ((jobs, spec) => startDeclaredMonitor(jobs, spec, { envPassthrough: deps.envPassthrough?.() ?? [] }));
  /** Session → monitor key → its job, or `null` when it could not start. */
  const started = new Map<string, Map<string, ShellJobRecord | null>>();
  const skippedLogged = new Set<string>();

  return {
    startFor(session) {
      let current: PluginMonitorList;
      try {
        current = list(deps.stateDir);
      } catch (err) {
        deps.logger.warn("plugin monitors not read", { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let mine = started.get(session.id);
      const wanted = new Set(current.monitors.map((m) => m.key));
      for (const [key, record] of mine ?? []) {
        if (wanted.has(key) || record === null || record.state !== "running") continue;
        deps.shellJobs.stop(record, "plugin_off");
        deps.logger.info("plugin monitor stopped", { sessionId: session.id, monitor: key });
      }
      for (const s of current.skipped) {
        const key = `${s.plugin}/${s.name}`;
        if (skippedLogged.has(key)) continue;
        skippedLogged.add(key);
        deps.logger.warn("plugin monitor skipped", { plugin: s.plugin, monitor: s.name, reason: s.reason });
      }
      for (const monitor of current.monitors) {
        const before = mine?.get(monitor.key);
        // Started already, unless the session's end or its plugin going off is what stopped it.
        if (before !== undefined && (before === null || (before.stopReason !== "session_end" && before.stopReason !== "plugin_off"))) continue;
        let result: DeclaredMonitorStart;
        try {
          result = start(deps.shellJobs, {
            sessionId: session.id,
            cwd: session.workingDir,
            commandLine: monitor.command,
            ...(monitor.until !== undefined ? { until: monitor.until } : {}),
            label: `plugin ${monitor.plugin}: ${monitor.description}`,
            origin: `the monitor "${monitor.name}" of plugin ${monitor.plugin}, which the user allowed to run code`,
          });
        } catch (err) {
          // A monitor that cannot start must never stop the turn.
          result = { ok: false, reason: err instanceof Error ? err.message : String(err), retry: false };
        }
        if (!result.ok) {
          deps.logger.warn("plugin monitor not started", { sessionId: session.id, monitor: monitor.key, reason: result.reason });
          if (result.retry) continue;
        } else {
          deps.logger.info("plugin monitor started", { sessionId: session.id, monitor: monitor.key, jobId: result.record.id });
        }
        if (!mine) {
          mine = new Map();
          started.set(session.id, mine);
        }
        mine.set(monitor.key, result.ok ? result.record : null);
      }
    },
  };
}
