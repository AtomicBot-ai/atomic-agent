import { buildCommandEnv } from "../../../sandbox/command-env.js";
import { startCommandJob, type CommandJob, type CommandJobOptions } from "../../../sandbox/command-job.js";
import { withToolchainEnv } from "../../../sandbox/command-toolchain-env.js";
import { attachJobMonitor } from "./shell-job-monitor-call.js";
import { compileWatchPattern } from "./shell-job-watch.js";
import type { ShellJobRecord, ShellJobRegistry } from "./shell-jobs.js";
import { resolveShellSpawn } from "./shell-interpretation.js";
import type { ShellCommandFacts } from "./shell-result.js";

/**
 * Start a monitor someone other than the model declared (a plugin's
 * `monitors`, ATO-2438): the command runs through the platform shell in
 * the session's folder as a kept job of that session, with the same
 * filtered environment as `os.shell.run`, and a monitor on it from its
 * first line. It is not asked about, like a plugin hook: the user's
 * consent to the plugin running code is checked by the caller. It
 * appears in `jobs` and `/ps` like any job, and `kill` / `/stop` end it.
 *
 * It never evicts the agent's own jobs: with `maxJobs` already running
 * in the session it does not start (`retry: true`).
 */

/** Without a pattern every line that is not blank is news. */
export const EVERY_LINE_PATTERN = "\\S";

export interface DeclaredMonitorSpec {
  sessionId: string;
  cwd: string;
  commandLine: string;
  /** Case-insensitive pattern; omitted means every non-blank line. */
  until?: string;
  /** What the notice calls it, e.g. `plugin deploy-tools: Deployment status`. */
  label: string;
  /** Who declared it, for the notice, e.g. `a monitor of plugin deploy-tools`. */
  origin: string;
}

export interface DeclaredMonitorOptions {
  envPassthrough?: readonly string[];
  /** Test seam. */
  start?: (command: string, args: string[], options: CommandJobOptions) => CommandJob;
}

export type DeclaredMonitorStart =
  | { ok: true; record: ShellJobRecord }
  | { ok: false; reason: string; retry: boolean };

export function startDeclaredMonitor(
  jobs: ShellJobRegistry,
  spec: DeclaredMonitorSpec,
  options: DeclaredMonitorOptions = {},
): DeclaredMonitorStart {
  const until = spec.until ?? EVERY_LINE_PATTERN;
  const compiled = compileWatchPattern(until);
  if (!compiled.ok) return { ok: false, reason: compiled.message, retry: false };
  if (!jobs.wake.canWake()) return { ok: false, reason: "nothing here can take monitor notices", retry: false };
  const running = jobs.list(spec.sessionId).filter((r) => r.state === "running").length;
  if (running >= jobs.maxJobs) {
    return { ok: false, reason: `the chat already runs ${running} background jobs (at most ${jobs.maxJobs})`, retry: true };
  }
  const spawn = resolveShellSpawn(spec.commandLine, [], true);
  const job = (options.start ?? startCommandJob)(spawn.command, spawn.args, {
    cwd: spec.cwd,
    env: withToolchainEnv(buildCommandEnv(process.env, options.envPassthrough ?? [])),
    ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const facts: ShellCommandFacts = {
    cmd: spec.commandLine,
    args: [],
    rawArgs: [],
    cwd: spec.cwd,
    shell: true,
    commandLine: spec.commandLine,
    noArguments: false,
    gog: false,
    guard: { action: "allow", rule: "plugin.monitor", reason: spec.origin },
  };
  const { record } = jobs.register(spec.sessionId, job, facts, true);
  attachJobMonitor(jobs, record, {
    command: spec.label,
    until,
    pattern: compiled.pattern,
    origin: spec.origin,
    everyLine: spec.until === undefined,
  });
  return { ok: true, record };
}
